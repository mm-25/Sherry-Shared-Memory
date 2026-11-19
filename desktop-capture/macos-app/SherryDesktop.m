#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#import "../macos/ax_snapshot.h"

@interface SherryApp : NSObject <NSApplicationDelegate, WKScriptMessageHandler>
@property NSWindow *window;
@property WKWebView *web;
@property NSTask *service;
@property NSStatusItem *statusItem;
@property NSMenuItem *captureMenuItem;
@property dispatch_queue_t snapshotQueue;
@end

@implementation SherryApp

- (NSString *)resource:(NSString *)name {
  return [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:name];
}

- (NSString *)nodePath {
  NSString *bundled = [[[NSBundle mainBundle] executablePath] stringByDeletingLastPathComponent];
  bundled = [bundled stringByAppendingPathComponent:@"SherryNode"];
  if ([[NSFileManager defaultManager] isExecutableFileAtPath:bundled]) return bundled;
  NSString *path = [[NSString stringWithContentsOfFile:[self resource:@"node-path"]
                                               encoding:NSUTF8StringEncoding error:nil]
                    stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if ([[NSFileManager defaultManager] isExecutableFileAtPath:path]) return path;
  return @"/opt/homebrew/bin/node";
}

- (NSString *)servicePath { return [self resource:@"desktop-capture/service.js"]; }

- (NSDictionary *)captureSnapshot:(NSString *)source {
  if (![@[ @"chatgpt", @"claude" ] containsObject:source])
    return @{ @"ok": @NO, @"error": @"Unknown capture source." };
  __block NSDictionary *result;
  dispatch_sync(self.snapshotQueue, ^{
    if (!AXIsProcessTrusted()) {
      result = @{ @"ok": @NO, @"error": @"Enable Sherry Desktop in System Settings > Privacy & Security > Accessibility." };
      return;
    }
    BOOL claude = [source isEqualToString:@"claude"];
    NSString *expected = claude ? @"/Applications/Claude.app/Contents/MacOS/Claude"
      : @"/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
    NSRunningApplication *target = nil;
    for (NSRunningApplication *candidate in [[NSWorkspace sharedWorkspace] runningApplications]) {
      if ([candidate.executableURL.path isEqualToString:expected]) { target = candidate; break; }
    }
    if (!target) {
      result = @{ @"ok": @NO, @"error": claude ? @"Open Claude to an ordinary conversation."
        : @"Open ChatGPT to a conversation." };
      return;
    }
    AXUIElementRef app = AXUIElementCreateApplication(target.processIdentifier);
    AXUIElementSetMessagingTimeout(app, 2.0);
    result = claude ? read_claude_snapshot(app) : read_chatgpt_snapshot(app);
    CFRelease(app);
  });
  return result;
}

- (void)readSnapshotRequests:(NSPipe *)requests replies:(NSPipe *)replies {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSMutableData *buffer = [NSMutableData data];
    @try {
      while (YES) {
        NSData *chunk = requests.fileHandleForReading.availableData;
        if (!chunk.length) break;
        [buffer appendData:chunk];
        // Requests contain only a source and correlation ID, never chat text.
        if (buffer.length > 4096) break;
        while (YES) {
          NSRange newline = [buffer rangeOfData:[NSData dataWithBytes:"\n" length:1]
            options:0 range:NSMakeRange(0, buffer.length)];
          if (newline.location == NSNotFound) break;
          NSData *line = [buffer subdataWithRange:NSMakeRange(0, newline.location)];
          [buffer replaceBytesInRange:NSMakeRange(0, newline.location + 1) withBytes:NULL length:0];
          id request = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
          if (![request isKindOfClass:[NSDictionary class]] || ![request[@"action"] isEqual:@"snapshot"]
              || ![request[@"id"] isKindOfClass:[NSNumber class]]) continue;
          NSMutableDictionary *reply = [[self captureSnapshot:request[@"source"]] mutableCopy];
          reply[@"id"] = request[@"id"];
          NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:reply options:0 error:nil] mutableCopy];
          [data appendBytes:"\n" length:1];
          [replies.fileHandleForWriting writeData:data];
        }
      }
    } @catch (NSException *exception) {
      // The child may exit while a snapshot is in progress. Never log transcripts.
    }
    [requests.fileHandleForReading closeFile];
    [replies.fileHandleForWriting closeFile];
  });
}

- (NSDictionary *)runCommand:(NSArray<NSString *> *)arguments input:(NSData *)input {
  NSTask *task = [NSTask new];
  task.executableURL = [NSURL fileURLWithPath:[self nodePath]];
  task.arguments = [[NSArray arrayWithObject:[self servicePath]] arrayByAddingObjectsFromArray:arguments];
  NSPipe *output = [NSPipe pipe], *errors = [NSPipe pipe];
  task.standardOutput = output;
  task.standardError = errors;
  NSPipe *stdinPipe = nil;
  if (input) { stdinPipe = [NSPipe pipe]; task.standardInput = stdinPipe; }
  NSError *launchError = nil;
  if (![task launchAndReturnError:&launchError]) {
    return @{ @"ok": @NO, @"error": launchError.localizedDescription ?: @"Could not launch capture service." };
  }
  if (stdinPipe) {
    [[stdinPipe fileHandleForWriting] writeData:input];
    [[stdinPipe fileHandleForWriting] closeFile];
  }
  // Drain both pipes while the process runs. Capture previews can exceed the
  // pipe capacity; waiting for exit before reading would deadlock the Test tab.
  __block NSData *stdoutData = nil, *stderrData = nil;
  dispatch_group_t readers = dispatch_group_create();
  dispatch_group_async(readers, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    stdoutData = [[output fileHandleForReading] readDataToEndOfFile];
  });
  dispatch_group_async(readers, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    stderrData = [[errors fileHandleForReading] readDataToEndOfFile];
  });
  [task waitUntilExit];
  dispatch_group_wait(readers, DISPATCH_TIME_FOREVER);
  NSString *stdoutText = [[NSString alloc] initWithData:stdoutData
                                           encoding:NSUTF8StringEncoding] ?: @"";
  NSString *stderrText = [[NSString alloc] initWithData:stderrData
                                           encoding:NSUTF8StringEncoding] ?: @"";
  if (task.terminationStatus != 0) return @{ @"ok": @NO,
    @"error": stderrText.length ? stderrText : @"Capture service command failed." };
  return @{ @"ok": @YES, @"value": stdoutText };
}

- (void)startService {
  if (self.service.isRunning) return;
  NSTask *task = [NSTask new];
  task.executableURL = [NSURL fileURLWithPath:[self nodePath]];
  task.arguments = @[ [self servicePath], @"run" ];
  NSMutableDictionary *environment = [[[NSProcessInfo processInfo] environment] mutableCopy];
  environment[@"SHERRY_NATIVE_CAPTURE_PIPE"] = @"1";
  task.environment = environment;
  NSPipe *requests = [NSPipe pipe], *replies = [NSPipe pipe];
  task.standardOutput = requests;
  task.standardInput = replies;
  task.standardError = [NSFileHandle fileHandleWithNullDevice];
  __weak SherryApp *weakSelf = self;
  task.terminationHandler = ^(NSTask *ended) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2000000000LL), dispatch_get_main_queue(), ^{
      SherryApp *strongSelf = weakSelf;
      if (strongSelf && strongSelf.service == ended) {
        strongSelf.service = nil;
        [strongSelf startService];
      }
    });
  };
  NSError *error = nil;
  if ([task launchAndReturnError:&error]) {
    self.service = task;
    [self readSnapshotRequests:requests replies:replies];
  }
}

- (void)stopService {
  NSTask *task = self.service;
  self.service = nil;
  if (task.isRunning) {
    [task terminate];
    [task waitUntilExit];
  }
}

- (NSDictionary *)request:(NSString *)path body:(NSDictionary *)body token:(NSString *)token {
  NSString *url = [@"https://zwpzmmfpgjaaikacoqas.supabase.co" stringByAppendingString:path];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:url]];
  request.timeoutInterval = 20;
  [request setValue:@"sb_publishable_mEtfpCKWHYDKARfWNNO5BA_ouWQWmfN" forHTTPHeaderField:@"apikey"];
  [request setValue:@"application/json" forHTTPHeaderField:@"content-type"];
  if (token) [request setValue:[@"Bearer " stringByAppendingString:token] forHTTPHeaderField:@"authorization"];
  if (body) {
    request.HTTPMethod = @"POST";
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
  }
  __block NSData *responseData = nil;
  __block NSHTTPURLResponse *response = nil;
  __block NSError *requestError = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data,
      NSURLResponse *result, NSError *error) {
    responseData = data;
    response = (NSHTTPURLResponse *)result;
    requestError = error;
    dispatch_semaphore_signal(done);
  }] resume];
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 25000000000LL));
  if (requestError || !response) return @{ @"ok": @NO, @"error": @"Could not reach Sherry. Check your connection." };
  if (response.statusCode < 200 || response.statusCode >= 300) return @{ @"ok": @NO,
    @"error": response.statusCode == 400 || response.statusCode == 401
      ? @"The email or password was not accepted." : [NSString stringWithFormat:@"Sign in returned HTTP %ld.", (long)response.statusCode] };
  id object = [NSJSONSerialization JSONObjectWithData:responseData options:0 error:nil];
  return object ? @{ @"ok": @YES, @"value": object } : @{ @"ok": @NO, @"error": @"Sherry returned an invalid response." };
}

- (NSDictionary *)signIn:(NSDictionary *)payload {
  NSString *email = payload[@"email"], *password = payload[@"password"];
  if (![email isKindOfClass:[NSString class]] || ![password isKindOfClass:[NSString class]]
      || !email.length || !password.length) return @{ @"ok": @NO, @"error": @"Enter your email and password." };
  NSDictionary *auth = [self request:@"/auth/v1/token?grant_type=password"
                             body:@{ @"email": email, @"password": password } token:nil];
  if (![auth[@"ok"] boolValue]) return auth;
  NSDictionary *session = auth[@"value"];
  if (![session[@"access_token"] isKindOfClass:[NSString class]]
      || ![session[@"refresh_token"] isKindOfClass:[NSString class]]
      || ![session[@"expires_at"] isKindOfClass:[NSNumber class]]) {
    return @{ @"ok": @NO, @"error": @"Account response was incomplete." };
  }
  NSDictionary *spaces = [self request:@"/rest/v1/workspaces?select=id,name&limit=1"
                               body:nil token:session[@"access_token"]];
  if (![spaces[@"ok"] boolValue]) return spaces;
  NSArray *items = spaces[@"value"];
  NSDictionary *workspace = [items isKindOfClass:[NSArray class]] ? items.firstObject : nil;
  if (![workspace[@"id"] isKindOfClass:[NSString class]]) {
    return @{ @"ok": @NO, @"error": @"No Sherry workspace was found for this account." };
  }
  NSDictionary *connection = @{ @"workspaceId": workspace[@"id"],
    @"workspaceName": workspace[@"name"] ?: @"Personal space", @"email": email,
    @"accessToken": session[@"access_token"], @"refreshToken": session[@"refresh_token"],
    @"expiresAt": session[@"expires_at"] };
  NSData *data = [NSJSONSerialization dataWithJSONObject:connection options:0 error:nil];
  NSDictionary *saved = [self runCommand:@[ @"connect" ] input:data];
  if ([saved[@"ok"] boolValue]) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self startService]; });
    return @{ @"ok": @YES, @"value": @{ @"email": email,
      @"workspaceName": connection[@"workspaceName"] } };
  }
  return saved;
}

- (NSDictionary *)status {
  NSString *home = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Sherry/DesktopCapture/status.json"];
  NSData *data = [NSData dataWithContentsOfFile:home];
  NSMutableDictionary *status = data ? [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] mutableCopy] : [NSMutableDictionary new];
  if (!status) status = [NSMutableDictionary new];
  NSData *controlsData = [NSData dataWithContentsOfFile:[[home stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"controls.json"]];
  NSDictionary *controls = controlsData ? [NSJSONSerialization JSONObjectWithData:controlsData options:0 error:nil] : nil;
  for (NSString *key in @[ @"paused", @"sources", @"captureFrom" ]) {
    if (controls[key]) status[key] = controls[key];
  }
  status[@"accessibilityGranted"] = @(AXIsProcessTrusted());
  BOOL paused = status[@"paused"] ? [status[@"paused"] boolValue] : YES;
  dispatch_async(dispatch_get_main_queue(), ^{
    self.captureMenuItem.title = paused ? @"Start capture" : @"Pause capture";
  });
  return @{ @"ok": @YES, @"value": status ?: @{} };
}

- (NSDictionary *)handle:(NSDictionary *)request {
  NSString *action = request[@"action"];
  if ([action isEqualToString:@"account"]) {
    NSDictionary *result = [self runCommand:@[ @"account" ] input:nil];
    if (![result[@"ok"] boolValue]) return result;
    id value = [NSJSONSerialization JSONObjectWithData:[result[@"value"] dataUsingEncoding:NSUTF8StringEncoding]
                                                 options:NSJSONReadingFragmentsAllowed error:nil];
    if ([value isKindOfClass:[NSDictionary class]]) dispatch_async(dispatch_get_main_queue(), ^{ [self startService]; });
    return @{ @"ok": @YES, @"value": value ?: [NSNull null] };
  }
  if ([action isEqualToString:@"signIn"]) return [self signIn:request];
  if ([action isEqualToString:@"status"]) return [self status];
  if ([action isEqualToString:@"captureLog"]) {
    NSString *source = request[@"source"];
    if (![ @[ @"codex", @"antigravity", @"chatgpt", @"claude" ] containsObject:source])
      return @{ @"ok": @NO, @"error": @"Unknown capture log source." };
    NSDictionary *result = [self runCommand:@[ @"capture-log", source ] input:nil];
    if (![result[@"ok"] boolValue]) return result;
    id value = [NSJSONSerialization JSONObjectWithData:[result[@"value"] dataUsingEncoding:NSUTF8StringEncoding]
                                             options:0 error:nil];
    return value ? @{ @"ok": @YES, @"value": value }
      : @{ @"ok": @NO, @"error": @"The local capture log could not be read." };
  }
  if ([action isEqualToString:@"pause"] || [action isEqualToString:@"enable"]) {
    return [self runCommand:@[ action ] input:nil];
  }
  if ([action isEqualToString:@"source"]) {
    NSString *source = request[@"source"];
    if (![ @[ @"codex", @"chatgpt", @"claude", @"antigravity" ] containsObject:source])
      return @{ @"ok": @NO, @"error": @"Unknown source." };
    return [self runCommand:@[ @"source", source, [request[@"enabled"] boolValue] ? @"on" : @"off" ] input:nil];
  }
  if ([action isEqualToString:@"verify"]) {
    NSString *source = request[@"source"];
    if (![ @[ @"chatgpt", @"claude" ] containsObject:source])
      return @{ @"ok": @NO, @"error": @"Only ChatGPT and Claude use visible window checks." };
    NSString *bundleId = [source isEqualToString:@"claude"]
      ? @"com.anthropic.claudefordesktop" : @"com.openai.codex";
    NSRunningApplication *target = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId].firstObject;
    if (target) {
      dispatch_sync(dispatch_get_main_queue(), ^{
        [target activateWithOptions:0];
      });
      [NSThread sleepForTimeInterval:0.7];
    }
    NSDictionary *snapshot = [self captureSnapshot:source];
    NSDictionary *result = snapshot;
    if ([snapshot[@"ok"] boolValue]) {
      NSData *input = [NSJSONSerialization dataWithJSONObject:snapshot[@"value"] options:0 error:nil];
      result = [self runCommand:@[ @"verify", source, @"--stdin" ] input:input];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      [self.window makeKeyAndOrderFront:nil];
      [NSApp activateIgnoringOtherApps:YES];
    });
    if (![result[@"ok"] boolValue]) return result;
    id value = [NSJSONSerialization JSONObjectWithData:[result[@"value"] dataUsingEncoding:NSUTF8StringEncoding]
                                                 options:0 error:nil];
    return value ? @{ @"ok": @YES, @"value": value } : @{ @"ok": @NO, @"error": @"Verification result was invalid." };
  }
  if ([action isEqualToString:@"signOut"]) {
    [self stopService];
    return [self runCommand:@[ @"disconnect" ] input:nil];
  }
  if ([action isEqualToString:@"accessibility"]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
      AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
      [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]];
    });
    return @{ @"ok": @YES };
  }
  if ([action isEqualToString:@"showApp"]) {
    NSString *path = [[NSBundle mainBundle] bundlePath];
    dispatch_async(dispatch_get_main_queue(), ^{
      [[NSWorkspace sharedWorkspace] activateFileViewerSelectingURLs:@[[NSURL fileURLWithPath:path]]];
    });
    return @{ @"ok": @YES };
  }
  return @{ @"ok": @NO, @"error": @"Unknown app action." };
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  NSDictionary *request = [message.body isKindOfClass:[NSDictionary class]] ? message.body : @{};
  NSNumber *identifier = request[@"id"];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSDictionary *result = [self handle:request];
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingFragmentsAllowed error:nil];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"{}";
    dispatch_async(dispatch_get_main_queue(), ^{
      [self.web evaluateJavaScript:[NSString stringWithFormat:@"window.sherryResolve(%@, %@)", identifier ?: @0, json]
               completionHandler:nil];
    });
  });
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.snapshotQueue = dispatch_queue_create("com.sherry.desktop.snapshot", DISPATCH_QUEUE_SERIAL);
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 860, 760)
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
    backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Sherry Desktop";
  self.window.minSize = NSMakeSize(700, 650);
  [self.window center];
  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  [config.userContentController addScriptMessageHandler:self name:@"sherry"];
  self.web = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
  self.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  self.window.contentView = self.web;
  NSURL *page = [NSURL fileURLWithPath:[self resource:@"desktop-ui/index.html"]];
  [self.web loadFileURL:page allowingReadAccessToURL:[page URLByDeletingLastPathComponent]];
  [self.window makeKeyAndOrderFront:nil];
  self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
  self.statusItem.button.title = @"S";
  self.statusItem.button.toolTip = @"Sherry Desktop";
  NSMenu *menu = [NSMenu new];
  NSMenuItem *openItem = [[NSMenuItem alloc] initWithTitle:@"Open Sherry" action:@selector(showWindow:) keyEquivalent:@""];
  openItem.target = self; [menu addItem:openItem];
  self.captureMenuItem = [[NSMenuItem alloc] initWithTitle:@"Start capture" action:@selector(toggleCapture:) keyEquivalent:@""];
  self.captureMenuItem.target = self; [menu addItem:self.captureMenuItem];
  [menu addItem:[NSMenuItem separatorItem]];
  NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:@"Quit Sherry" action:@selector(quitApp:) keyEquivalent:@""];
  quitItem.target = self; [menu addItem:quitItem];
  self.statusItem.menu = menu;
  [NSApp activateIgnoringOtherApps:YES];
}

- (void)showWindow:(id)sender {
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

- (void)toggleCapture:(id)sender {
  NSDictionary *current = [self status][@"value"];
  BOOL paused = current[@"paused"] ? [current[@"paused"] boolValue] : YES;
  NSString *command = paused ? @"enable" : @"pause";
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSDictionary *result = [self runCommand:@[ command ] input:nil];
    if ([result[@"ok"] boolValue]) dispatch_async(dispatch_get_main_queue(), ^{
      self.captureMenuItem.title = paused ? @"Pause capture" : @"Start capture";
    });
  });
}

- (void)quitApp:(id)sender { [NSApp terminate:nil]; }

- (void)applicationWillTerminate:(NSNotification *)notification { [self stopService]; }
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return NO; }
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {
  if (!visible) [self showWindow:nil];
  return YES;
}
@end

int main(int argc, const char *argv[]) {
  signal(SIGPIPE, SIG_IGN);
  @autoreleasepool {
    if (argc == 3 && (!strcmp(argv[1], "--claude-snapshot") || !strcmp(argv[1], "--snapshot"))) {
      char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
      char *end = NULL;
      long requested = strtol(argv[2], &end, 10);
      const char *expected = !strcmp(argv[1], "--claude-snapshot")
        ? "/Applications/Claude.app/Contents/MacOS/Claude"
        : "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
      if (!end || *end || requested <= 0 || proc_pidpath((pid_t)requested, path, sizeof(path)) <= 0
          || strcmp(path, expected)) {
        fputs("Target process is not the expected desktop app.\n", stderr);
        return 2;
      }
      if (!AXIsProcessTrusted()) {
        fputs("Enable Sherry Desktop in System Settings > Privacy & Security > Accessibility.\n", stderr);
        return 3;
      }
      AXUIElementRef app = AXUIElementCreateApplication((pid_t)requested);
      int result = !strcmp(argv[1], "--claude-snapshot")
        ? write_claude_snapshot(app) : write_chatgpt_snapshot(app);
      CFRelease(app);
      return result;
    }
    NSApplication *application = [NSApplication sharedApplication];
    SherryApp *delegate = [SherryApp new];
    application.delegate = delegate;
    [application run];
  }
  return 0;
}
