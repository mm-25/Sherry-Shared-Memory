#!/usr/bin/env python3
"""Bounded, redacted ChatGPT navigation check. Never changes Sherry capture or delivery."""
import argparse, hashlib, json, re, subprocess, tempfile, time
from pathlib import Path

PKG = 'dev.sherry.capture.verifier'
SOURCE = 'com.openai.chatgpt'


def reply_is_complete(items, reply):
    def has(label):
        return any(label in (n.get('text'), n.get('description')) for n in items)
    return (has(reply) or has(reply + '.')) and has('Read aloud') and not any(has(label) for label in ('Stop', 'Stop generating', 'Stop response'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--test-apk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--run', required=True)
    parser.add_argument('--expected-sha', help='Require the previously verified paused encrypted-state SHA before starting.')
    parser.add_argument('--observe-only', action='store_true', help='Read the owner-opened source menu; perform no source UI actions.')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9-]{1,32}', args.run):
        parser.error('Invalid controlled run label')
    args.output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    work_deadline = started + (12 if args.observe_only else 70)
    cleanup_deadline = started + (20 if args.observe_only else 90)
    installed = []
    process = None
    stages = []
    result = {'run': args.run, 'completed': False, 'sourceNavigationVerified': False}
    sequence = 0

    def adb(*argv, input=None, cleanup=False, check=True):
        remaining = (cleanup_deadline if cleanup else work_deadline) - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Bounded test deadline reached')
        p = subprocess.run([args.adb, '-s', args.serial, *map(str, argv)], input=input,
                           capture_output=True, timeout=min(8, remaining))
        if check and p.returncode:
            raise RuntimeError('adb_command_failed')
        return p.stdout

    def foreground():
        output = adb('shell', 'dumpsys', 'window').decode()
        focus = next((line for line in output.splitlines() if 'mCurrentFocus=' in line), '')
        focused_app = next((line for line in output.splitlines() if 'mFocusedApp=' in line), '')
        source_window = SOURCE + '/' in focus or ('PopupWindow' in focus and SOURCE + '/' in focused_app)
        return source_window and 'NotificationShade' not in focus and 'isKeyguardShowing=true' not in output

    def trace():
        data = json.loads(adb('exec-out', 'run-as', PKG, 'cat', 'files/navigation-trace.json'))
        if data.get('run') != args.run:
            raise RuntimeError('wrong_trace_run')
        return data

    def nodes(node):
        yield node
        for child in node.get('children', []):
            yield from nodes(child)

    def latest():
        data = trace()
        return data, [n for n in nodes(data['snapshots'][-1]['root']) if n.get('visible')]

    def wait_for(predicate, seconds=4):
        deadline = min(work_deadline, time.monotonic() + seconds)
        while time.monotonic() < deadline:
            try:
                data, items = latest()
                if predicate(items):
                    return data, items
            except (json.JSONDecodeError, KeyError, RuntimeError):
                pass
            time.sleep(.2)
        raise TimeoutError('source_condition_not_ready')

    def has(items, label):
        return any(label in (n.get('text'), n.get('description')) for n in items)

    def checkpoint(label):
        data, _ = latest()
        stages.append({'stage': label, 'snapshot': data['snapshots'][-1]})
        if label in {'A-reply', 'B-reply'}:
            (args.output / (label + '-trace.json')).write_text(json.dumps(data, indent=2) + '\n')
        print(json.dumps({'stage': label, 'elapsedSeconds': round(time.monotonic() - started, 1)}), flush=True)

    def command(action, label):
        nonlocal sequence
        if not foreground():
            raise RuntimeError('source_not_foreground_or_phone_locked')
        sequence += 1
        body = json.dumps({'run': args.run, 'sequence': sequence, 'action': action, 'label': label}).encode()
        # shell copy/move wait for completion; exec-in returned before the earlier write completed.
        with tempfile.TemporaryDirectory(prefix='sherry-nav-') as temp:
            file = Path(temp) / 'command.json'
            file.write_bytes(body)
            adb('push', file, '/data/local/tmp/sherry-navigation-command.json')
            adb('shell', 'run-as', PKG, 'cp', '/data/local/tmp/sherry-navigation-command.json', 'files/trace-command.new')
            adb('shell', 'run-as', PKG, 'mv', 'files/trace-command.new', 'files/trace-command.json')
            adb('shell', 'rm', '/data/local/tmp/sherry-navigation-command.json')
        deadline = min(work_deadline, time.monotonic() + 4)
        while time.monotonic() < deadline:
            try:
                reply = json.loads(adb('exec-out', 'run-as', PKG, 'cat', 'files/trace-command-result.json'))
                if reply.get('sequence') == sequence:
                    if not reply.get('ok'):
                        result['controlFailure'] = reply  # Test-host enums/counts only.
                        raise RuntimeError('guarded_control_not_ready')
                    return
            except json.JSONDecodeError:
                pass
            time.sleep(.15)
        raise TimeoutError('controller_ack_missing')

    def tap_public(labels):
        _, items = wait_for(lambda items: any(has(items, label) for label in labels))
        for label in labels:
            matches = [n for n in items if n.get('text') == label or n.get('description') == label]
            if matches:
                n = matches[0]
                action = 'tap_description' if n.get('description') == label else 'tap_text'
                command(action, label)
                return
        raise RuntimeError('public_control_missing')

    def rename(label):
        tap_public(['Edit Menu'])
        checkpoint(label + '-edit-menu')
        tap_public(['Rename', 'Rename chat', 'Rename conversation'])
        command('set_title', label)
        tap_public(['Save', 'Save changes', 'Done'])
        wait_for(lambda items: has(items, 'Reply to ChatGPT'))

    def exchange(label, reply):
        command('set_prompt', label)
        tap_public(['Send Message', 'Send'])
        wait_for(lambda items: reply_is_complete(items, reply), seconds=10)
        checkpoint(label + '-reply')
        if label == 'A':
            previous = trace()['snapshots'][-1]['elapsedMs']
            tap_public(['Menu'])
            deadline = min(work_deadline, time.monotonic() + 3)
            while time.monotonic() < deadline:
                if trace()['snapshots'][-1]['elapsedMs'] > previous:
                    break
                time.sleep(.2)
            time.sleep(.4)
            checkpoint('A-history-before-rename')
            if not foreground():
                raise RuntimeError('source_not_foreground')
            adb('shell', 'input', 'keyevent', '4')
            wait_for(lambda items: has(items, 'Reply to ChatGPT'))
        rename(label)

    try:
        old = adb('shell', 'pm', 'list', 'packages', PKG).decode().splitlines()
        if any(line.strip() == 'package:' + PKG for line in old):
            raise RuntimeError('existing_verifier_preserved')
        encrypted = adb('exec-out', 'run-as', 'dev.sherry.capture', 'cat', 'no_backup/capture-v1.enc')
        result['beforeEncryptedSha256'] = hashlib.sha256(encrypted).hexdigest()
        if args.expected_sha and result['beforeEncryptedSha256'] != args.expected_sha:
            raise RuntimeError('state_changed_since_paused_baseline')
        result['capturePidBefore'] = adb('shell', 'pidof', 'dev.sherry.capture').decode().strip()
        adb('install', '-r', args.apk)
        installed.append(PKG)
        adb('install', '-r', args.test_apk)
        installed.append(PKG + '.test')
        window = adb('shell', 'dumpsys', 'window').decode()
        if 'isKeyguardShowing=true' in window:
            raise RuntimeError('phone_locked')
        if args.observe_only:
            if not foreground():
                raise RuntimeError('source_not_foreground')
        else:
            adb('shell', 'cmd', 'statusbar', 'collapse')
            adb('shell', 'am', 'start', '-W', '-n', SOURCE + '/.MainActivity')
        log = open(args.output / 'instrumentation.log', 'wb')
        process = subprocess.Popen([args.adb, '-s', args.serial, 'shell', 'am', 'instrument', '-w', '-r',
            '-e', 'class', PKG + '.NavigationMetadataTest', '-e', 'sherry.trace', 'true', '-e', 'sherry.control', 'false' if args.observe_only else 'true',
            '-e', 'sherry.run', args.run, '-e', 'sherry.seconds', '10' if args.observe_only else '70',
            PKG + '.test/androidx.test.runner.AndroidJUnitRunner'], stdout=log, stderr=subprocess.STDOUT)
        data, items = wait_for(lambda items: True, seconds=5)
        if args.observe_only:
            checkpoint('owner-opened-menu-readonly')
        else:
            if any(has(items, label) for label in ['Rename', 'Rename chat', 'Rename conversation']) and not any(n.get('editable') for n in items):
                if not foreground():
                    raise RuntimeError('source_not_foreground')
                adb('shell', 'input', 'keyevent', '4')  # Close an existing menu; never confirm an action.
                _, items = wait_for(lambda items: has(items, 'New chat') or has(items, 'Ask ChatGPT'))
            if not has(items, 'Ask ChatGPT'):
                tap_public(['New chat'])
            wait_for(lambda items: has(items, 'Ask ChatGPT'))
            checkpoint('empty-home')
            exchange('A', 'amber notebook')
            tap_public(['New chat'])
            wait_for(lambda items: has(items, 'Ask ChatGPT'))
            exchange('B', 'cedar window')
            tap_public(['Menu'])
            checkpoint('B-history')
            tap_public(['Sherry reliability ' + args.run + ' A'])
            wait_for(lambda items: has(items, 'amber notebook') or has(items, 'amber notebook.'))
            checkpoint('A-return')
            adb('shell', 'am', 'force-stop', SOURCE)
            adb('shell', 'am', 'start', '-W', '-n', SOURCE + '/.MainActivity')
            wait_for(lambda items: has(items, 'Menu'))
            checkpoint('provider-restart')
        result['completed'] = True
    except Exception as error:
        result['errorType'] = type(error).__name__
        # Only controlled errors; do not serialize arbitrary ADB output or source text.
        if str(error) in {'phone_locked', 'existing_verifier_preserved', 'source_not_foreground',
                         'source_not_foreground_or_phone_locked', 'guarded_control_not_ready',
                         'controller_ack_missing', 'source_condition_not_ready', 'Bounded test deadline reached', 'state_changed_since_paused_baseline'}:
            result['errorCode'] = str(error)
    finally:
        if PKG in installed:
            try:
                adb('shell', 'run-as', PKG, 'touch', 'files/trace-stop', cleanup=True)
                if process:
                    try:
                        process.wait(timeout=min(3, max(.1, cleanup_deadline - time.monotonic())))
                    except subprocess.TimeoutExpired:
                        process.terminate()
                data = json.loads(adb('exec-out', 'run-as', PKG, 'cat', 'files/navigation-trace.json', cleanup=True))
                (args.output / 'redacted-trace.json').write_text(json.dumps(data, indent=2) + '\n')
                result['snapshots'] = len(data['snapshots'])
                result['events'] = len(data['events'])
            except Exception:
                result['traceExportIncomplete'] = True
        (args.output / 'stage-snapshots.json').write_text(json.dumps(stages, indent=2) + '\n')
        try:
            encrypted = adb('exec-out', 'run-as', 'dev.sherry.capture', 'cat', 'no_backup/capture-v1.enc', cleanup=True)
            result['afterEncryptedSha256'] = hashlib.sha256(encrypted).hexdigest()
            result['encryptedStoreUnchanged'] = result.get('beforeEncryptedSha256') == result['afterEncryptedSha256']
            result['capturePidAfter'] = adb('shell', 'pidof', 'dev.sherry.capture', cleanup=True).decode().strip()
        except Exception:
            result['savedStateVerificationIncomplete'] = True
        result['removedPackages'] = {}
        for package in reversed(installed):
            try:
                result['removedPackages'][package] = adb('uninstall', package, cleanup=True).decode().strip() == 'Success'
            except Exception:
                result['removedPackages'][package] = False
        if process and process.poll() is None:
            process.terminate()
        result['elapsedSeconds'] = round(time.monotonic() - started, 1)
        (args.output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result), flush=True)
    return 0 if result['completed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
