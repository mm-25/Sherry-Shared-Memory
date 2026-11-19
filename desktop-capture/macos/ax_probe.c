#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "ax_snapshot.h"

// Structural diagnostic only: never prints or stores any UI text.
static int remaining = 6000;
static int identify_web_areas = 0;
static int list_attributes = 0;
static int show_dom = 0;
static int show_headings = 0;
static void short_string(CFTypeRef value, char *output, size_t capacity);

static int allowed_process(pid_t pid) {
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidpath(pid, path, sizeof(path)) <= 0) return 0;
  return strncmp(path, "/Applications/ChatGPT.app/", 26) == 0
      || strncmp(path, "/Applications/Claude.app/", 25) == 0
      || strncmp(path, "/Applications/Antigravity.app/", 30) == 0;
}

static int chatgpt_process(pid_t pid) {
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  return proc_pidpath(pid, path, sizeof(path)) > 0
      && strncmp(path, "/Applications/ChatGPT.app/", 26) == 0;
}

static int claude_process(pid_t pid) {
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  return proc_pidpath(pid, path, sizeof(path)) > 0
      && strncmp(path, "/Applications/Claude.app/", 25) == 0;
}

static CFTypeRef copy_attribute(AXUIElementRef element, CFStringRef key) {
  CFTypeRef result = NULL;
  AXError error;
  for (int attempt = 0; attempt < 3; attempt++) {
    error = AXUIElementCopyAttributeValue(element, key, &result);
    if (error != kAXErrorCannotComplete) break;
    usleep(100000);
  }
  if (error != kAXErrorSuccess) return NULL;
  return result;
}

static void print_attribute_names(AXUIElementRef element, int depth) {
  CFArrayRef names = NULL;
  if (AXUIElementCopyAttributeNames(element, &names) != kAXErrorSuccess || !names) return;
  printf("%*sattributes=", depth * 2 + 2, "");
  for (CFIndex i = 0; i < CFArrayGetCount(names); i++) {
    CFTypeRef name = CFArrayGetValueAtIndex(names, i);
    char buffer[128];
    short_string(name, buffer, sizeof(buffer));
    printf("%s%s", i ? "," : "", buffer);
  }
  putchar('\n');
  CFRelease(names);
}

static int contains_window(CFTypeRef children) {
  if (!children || CFGetTypeID(children) != CFArrayGetTypeID()) return 0;
  CFArrayRef array = (CFArrayRef)children;
  for (CFIndex i = 0; i < CFArrayGetCount(array); i++) {
    CFTypeRef child = CFArrayGetValueAtIndex(array, i);
    if (!child || CFGetTypeID(child) != AXUIElementGetTypeID()) continue;
    CFTypeRef role = copy_attribute((AXUIElementRef)child, kAXRoleAttribute);
    int found = role && CFEqual(role, kAXWindowRole);
    if (role) CFRelease(role);
    if (found) return 1;
  }
  return 0;
}

static int is_window(CFTypeRef element) {
  if (!element || CFGetTypeID(element) != AXUIElementGetTypeID()) return 0;
  CFTypeRef role = copy_attribute((AXUIElementRef)element, kAXRoleAttribute);
  int found = role && CFEqual(role, kAXWindowRole);
  if (role) CFRelease(role);
  return found;
}

static void short_string(CFTypeRef value, char *output, size_t capacity) {
  if (!value || CFGetTypeID(value) != CFStringGetTypeID()
      || !CFStringGetCString((CFStringRef)value, output, capacity, kCFStringEncodingUTF8)) {
    snprintf(output, capacity, "?");
  }
}

static void print_dom_metadata(AXUIElementRef element, int depth) {
  CFTypeRef identifier = copy_attribute(element, CFSTR("AXDOMIdentifier"));
  CFTypeRef classes = copy_attribute(element, CFSTR("AXDOMClassList"));
  if (!identifier && !classes) return;
  char id[256];
  short_string(identifier, id, sizeof(id));
  if (identifier && strcmp(id, "?") != 0 && id[0]) {
    printf("%*sdomId=%s\n", depth * 2 + 2, "", id);
  }
  if (classes && CFGetTypeID(classes) == CFArrayGetTypeID()) {
    CFArrayRef array = (CFArrayRef)classes;
    if (CFArrayGetCount(array) > 0) {
      printf("%*sdomClasses=", depth * 2 + 2, "");
      for (CFIndex i = 0; i < CFArrayGetCount(array) && i < 12; i++) {
        char name[128];
        short_string(CFArrayGetValueAtIndex(array, i), name, sizeof(name));
        printf("%s%s", i ? "," : "", name);
      }
      putchar('\n');
    }
  }
  if (identifier) CFRelease(identifier);
  if (classes) CFRelease(classes);
}

static long text_length(CFTypeRef value) {
  if (!value) return -1;
  if (CFGetTypeID(value) == CFStringGetTypeID()) return CFStringGetLength((CFStringRef)value);
  if (CFGetTypeID(value) == CFAttributedStringGetTypeID()) return CFAttributedStringGetLength((CFAttributedStringRef)value);
  return -1;
}

static void inspect(AXUIElementRef element, int depth) {
  if (remaining-- <= 0 || depth > 48) return;
  CFTypeRef role = copy_attribute(element, kAXRoleAttribute);
  CFTypeRef subrole = copy_attribute(element, kAXSubroleAttribute);
  CFTypeRef value = copy_attribute(element, kAXValueAttribute);
  CFTypeRef title = copy_attribute(element, kAXTitleAttribute);
  CFTypeRef description = copy_attribute(element, kAXDescriptionAttribute);
  char role_name[128], subrole_name[128];
  short_string(role, role_name, sizeof(role_name));
  short_string(subrole, subrole_name, sizeof(subrole_name));
  printf("%*s%s subrole=%s valueChars=%ld titleChars=%ld descriptionChars=%ld\n",
      depth * 2, "", role_name, subrole_name,
      text_length(value), text_length(title), text_length(description));
  if (identify_web_areas && role && CFEqual(role, CFSTR("AXWebArea"))) {
    char web_title[256];
    short_string(title, web_title, sizeof(web_title));
    for (size_t i = 0; web_title[i]; i++) {
      if ((unsigned char)web_title[i] < 32) web_title[i] = ' ';
    }
    printf("%*swebAreaTitle=%s\n", depth * 2 + 2, "", web_title);
    CFTypeRef raw_url = copy_attribute(element, CFSTR("AXURL"));
    CFURLRef parsed_url = NULL;
    if (raw_url && CFGetTypeID(raw_url) == CFURLGetTypeID()) {
      parsed_url = (CFURLRef)CFRetain(raw_url);
    } else if (raw_url && CFGetTypeID(raw_url) == CFStringGetTypeID()) {
      parsed_url = CFURLCreateWithString(NULL, (CFStringRef)raw_url, NULL);
    }
    if (parsed_url) {
      CFStringRef scheme = CFURLCopyScheme(parsed_url);
      CFStringRef host = CFURLCopyHostName(parsed_url);
      CFStringRef path = CFURLCopyPath(parsed_url);
      char scheme_name[64], host_name[128], path_name[512];
      short_string(scheme, scheme_name, sizeof(scheme_name));
      short_string(host, host_name, sizeof(host_name));
      short_string(path, path_name, sizeof(path_name));
      printf("%*swebAreaURLParts=%s|%s|%s\n", depth * 2 + 2, "", scheme_name, host_name, path_name);
      if (scheme) CFRelease(scheme);
      if (host) CFRelease(host);
      if (path) CFRelease(path);
      CFRelease(parsed_url);
    }
    if (raw_url) CFRelease(raw_url);
  }
  if (list_attributes && ((role && CFEqual(role, CFSTR("AXWebArea")))
      || (subrole && (CFEqual(subrole, CFSTR("AXLandmarkMain"))
        || CFEqual(subrole, CFSTR("AXTabPanel")))))) {
    print_attribute_names(element, depth);
  }
  if (show_dom) print_dom_metadata(element, depth);
  if (show_headings && ((role && CFEqual(role, CFSTR("AXHeading")))
      || (subrole && CFEqual(subrole, CFSTR("AXDocumentArticle"))))) {
    char label[512];
    short_string(role && CFEqual(role, CFSTR("AXHeading")) ? title : description, label, sizeof(label));
    for (size_t i = 0; label[i]; i++) if ((unsigned char)label[i] < 32) label[i] = ' ';
    printf("%*s%s=%s\n", depth * 2 + 2, "",
      role && CFEqual(role, CFSTR("AXHeading")) ? "headingTitle" : "articleDescription", label);
  }
  if (role) CFRelease(role);
  if (subrole) CFRelease(subrole);
  if (value) CFRelease(value);
  if (title) CFRelease(title);
  if (description) CFRelease(description);

  CFTypeRef children = copy_attribute(element, kAXChildrenAttribute);
  if (children && CFGetTypeID(children) == CFArrayGetTypeID()) {
    CFArrayRef array = (CFArrayRef)children;
    for (CFIndex i = 0; i < CFArrayGetCount(array) && remaining > 0; i++) {
      CFTypeRef child = CFArrayGetValueAtIndex(array, i);
      if (child && CFGetTypeID(child) == AXUIElementGetTypeID()) {
        CFTypeRef childRole = copy_attribute((AXUIElementRef)child, kAXRoleAttribute);
        int isMenu = childRole && CFEqual(childRole, kAXMenuBarRole);
        int isApplication = childRole && CFEqual(childRole, kAXApplicationRole);
        if (childRole) CFRelease(childRole);
        if (!isMenu && !isApplication) inspect((AXUIElementRef)child, depth + 1);
      }
    }
  }
  if (children) CFRelease(children);
}

int main(int argc, char **argv) {
  if (argc < 2 || argc > 3 || (argc == 3 && strcmp(argv[2], "--request-permission") != 0
      && strcmp(argv[2], "--identify") != 0 && strcmp(argv[2], "--attributes") != 0
      && strcmp(argv[2], "--dom") != 0 && strcmp(argv[2], "--snapshot") != 0
      && strcmp(argv[2], "--headings") != 0 && strcmp(argv[2], "--claude-snapshot") != 0)) {
    fprintf(stderr, "Usage: ax_probe <PID of ChatGPT, Claude, or Antigravity main app> [--request-permission|--identify|--attributes|--dom|--headings|--snapshot|--claude-snapshot]\n");
    return 2;
  }
  identify_web_areas = argc == 3 && strcmp(argv[2], "--identify") == 0;
  list_attributes = argc == 3 && strcmp(argv[2], "--attributes") == 0;
  show_dom = argc == 3 && strcmp(argv[2], "--dom") == 0;
  show_headings = argc == 3 && strcmp(argv[2], "--headings") == 0;
  char *end = NULL;
  long requested = strtol(argv[1], &end, 10);
  if (!end || *end || requested <= 0 || !allowed_process((pid_t)requested)) {
    fprintf(stderr, "PID is not an allow-listed desktop app process.\n");
    return 2;
  }
  if (argc == 3 && strcmp(argv[2], "--snapshot") == 0 && !chatgpt_process((pid_t)requested)) {
    fputs("ChatGPT snapshot requires the ChatGPT main app process.\n", stderr);
    return 2;
  }
  if (argc == 3 && strcmp(argv[2], "--claude-snapshot") == 0 && !claude_process((pid_t)requested)) {
    fputs("Claude snapshot requires the Claude main app process.\n", stderr);
    return 2;
  }
  int trusted = AXIsProcessTrusted();
  if (!trusted && argc == 3 && strcmp(argv[2], "--request-permission") == 0) {
    const void *keys[] = { kAXTrustedCheckOptionPrompt };
    const void *values[] = { kCFBooleanTrue };
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    trusted = AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    // The permission prompt is asynchronous. Give the user time to approve it
    // so the first command can produce the structural output.
    for (int attempt = 0; !trusted && attempt < 60; attempt++) {
      usleep(500000);
      trusted = AXIsProcessTrusted();
    }
  }
  if (!trusted) {
    fprintf(stderr, "Accessibility permission is not granted for this launch context. When run from Terminal, enable Terminal in System Settings > Privacy & Security > Accessibility. A directly launched probe may require Sherry Accessibility Probe instead.\n");
    return 3;
  }
  AXUIElementRef app = AXUIElementCreateApplication((pid_t)requested);
  if (argc == 3 && strcmp(argv[2], "--snapshot") == 0) {
    int result = write_chatgpt_snapshot(app);
    CFRelease(app);
    return result;
  }
  if (argc == 3 && strcmp(argv[2], "--claude-snapshot") == 0) {
    int result = write_claude_snapshot(app);
    CFRelease(app);
    return result;
  }
  CFTypeRef children = copy_attribute(app, kAXChildrenAttribute);
  CFTypeRef windows = copy_attribute(app, kAXWindowsAttribute);
  CFIndex window_count = windows && CFGetTypeID(windows) == CFArrayGetTypeID()
      ? CFArrayGetCount((CFArrayRef)windows) : 0;
  int valid_window_count = 0;
  for (CFIndex i = 0; i < window_count; i++) {
    if (is_window(CFArrayGetValueAtIndex((CFArrayRef)windows, i))) valid_window_count++;
  }
  if (valid_window_count > 0) {
    puts("AXApplication (windows inspected directly)");
    for (CFIndex i = 0; i < CFArrayGetCount((CFArrayRef)windows); i++) {
      CFTypeRef window = CFArrayGetValueAtIndex((CFArrayRef)windows, i);
      if (is_window(window)) inspect((AXUIElementRef)window, 1);
    }
  } else if (contains_window(children)) {
    inspect(app, 0);
  } else {
    CFTypeRef diagnostic = NULL;
    AXError window_error = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &diagnostic);
    if (diagnostic) CFRelease(diagnostic);
    fprintf(stderr, "The target app has no accessible windows right now (AX error %d). Keep its conversation window open and retry.\n", window_error);
    if (windows) CFRelease(windows);
    if (children) CFRelease(children);
    CFRelease(app);
    return 5;
  }
  if (windows) CFRelease(windows);
  if (children) CFRelease(children);
  CFRelease(app);
  if (remaining <= 0) puts("nodeLimitReached=true");
  return 0;
}
