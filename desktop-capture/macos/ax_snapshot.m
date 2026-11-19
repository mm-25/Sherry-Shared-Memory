#import "ax_snapshot.h"
#import <Foundation/Foundation.h>

static CFTypeRef attribute(AXUIElementRef element, CFStringRef key) {
  CFTypeRef value = NULL;
  for (int attempt = 0; attempt < 3; attempt++) {
    AXError error = AXUIElementCopyAttributeValue(element, key, &value);
    if (error == kAXErrorSuccess) return value;
    if (error != kAXErrorCannotComplete) break;
    usleep(100000);
  }
  return NULL;
}

static NSString *string_attribute(AXUIElementRef element, CFStringRef key) {
  CFTypeRef raw = attribute(element, key);
  if (!raw) return nil;
  NSString *result = nil;
  if (CFGetTypeID(raw) == CFStringGetTypeID()) {
    result = [(__bridge NSString *)raw copy];
  } else if (CFGetTypeID(raw) == CFAttributedStringGetTypeID()) {
    result = [(__bridge NSString *)CFAttributedStringGetString((CFAttributedStringRef)raw) copy];
  }
  CFRelease(raw);
  return result;
}

static NSArray *children_of(AXUIElementRef element) {
  CFTypeRef raw = attribute(element, kAXChildrenAttribute);
  if (!raw) return @[];
  NSArray *result = CFGetTypeID(raw) == CFArrayGetTypeID() ? [(__bridge NSArray *)raw copy] : @[];
  CFRelease(raw);
  return result;
}

static NSArray<NSString *> *classes_of(AXUIElementRef element) {
  CFTypeRef raw = attribute(element, CFSTR("AXDOMClassList"));
  if (!raw) return @[];
  NSArray *result = CFGetTypeID(raw) == CFArrayGetTypeID() ? [(__bridge NSArray *)raw copy] : @[];
  CFRelease(raw);
  return result;
}

static BOOL has_class(NSArray<NSString *> *classes, NSString *fragment) {
  for (id item in classes) {
    if ([item isKindOfClass:[NSString class]] && [(NSString *)item containsString:fragment]) return YES;
  }
  return NO;
}

static AXUIElementRef find_element(AXUIElementRef root, NSString *wantedRole,
                                  NSString *wantedSubrole, NSString *classFragment,
                                  int depth, int *budget) {
  if (depth > 48 || (*budget)-- <= 0) return NULL;
  NSString *role = string_attribute(root, kAXRoleAttribute);
  NSString *subrole = string_attribute(root, kAXSubroleAttribute);
  if ((!wantedRole || [role isEqualToString:wantedRole])
      && (!wantedSubrole || [subrole isEqualToString:wantedSubrole])
      && (!classFragment || has_class(classes_of(root), classFragment))) {
    return (AXUIElementRef)CFRetain(root);
  }
  if ([role isEqualToString:@"AXMenuBar"] || (depth > 0 && [role isEqualToString:@"AXApplication"])) return NULL;
  for (id child in children_of(root)) {
    if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) continue;
    AXUIElementRef found = find_element((__bridge AXUIElementRef)child, wantedRole,
                                        wantedSubrole, classFragment, depth + 1, budget);
    if (found) return found;
  }
  return NULL;
}

typedef struct {
  NSMutableArray<NSMutableDictionary *> *turns;
  NSMutableDictionary *current;
  int block;
  int nodesLeft;
  NSUInteger characters;
  BOOL truncated;
} Snapshot;

static BOOL is_content_class(NSArray<NSString *> *classes) {
  return has_class(classes, @"bg-user-message") || has_class(classes, @"_Paragraph_")
      || has_class(classes, @"_ListItem_") || has_class(classes, @"_CodeBlock_")
      || has_class(classes, @"markdown") || has_class(classes, @"prose");
}

static BOOL starts_block(NSArray<NSString *> *classes) {
  return has_class(classes, @"_Paragraph_") || has_class(classes, @"_ListItem_")
      || has_class(classes, @"_CodeBlock_");
}

static void visit_transcript(AXUIElementRef element, Snapshot *snapshot, int depth,
                             BOOL contentScope, int block) {
  if (depth > 48 || snapshot->nodesLeft-- <= 0 || snapshot->characters > 1000000) {
    snapshot->truncated = YES;
    return;
  }
  NSString *role = string_attribute(element, kAXRoleAttribute);
  NSString *subrole = string_attribute(element, kAXSubroleAttribute);
  if ([role isEqualToString:@"AXButton"] || [role isEqualToString:@"AXPopUpButton"]
      || [role isEqualToString:@"AXToolbar"] || [role isEqualToString:@"AXMenuBar"]
      || [subrole isEqualToString:@"AXApplicationStatus"]) return;

  if ([role isEqualToString:@"AXHeading"]) {
    NSString *label = [string_attribute(element, kAXTitleAttribute) stringByTrimmingCharactersInSet:
                       [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSString *speaker = nil;
    if ([label isEqualToString:@"You said:"] || [label isEqualToString:@"You said"]) speaker = @"user";
    if ([label isEqualToString:@"ChatGPT said:"] || [label isEqualToString:@"ChatGPT said"]) speaker = @"assistant";
    if (speaker) {
      if (snapshot->turns.count >= 1000) { snapshot->truncated = YES; return; }
      snapshot->current = [@{ @"role": speaker, @"parts": [NSMutableArray array] } mutableCopy];
      [snapshot->turns addObject:snapshot->current];
      return;
    }
  }

  NSArray<NSString *> *classes = classes_of(element);
  BOOL withinContent = contentScope || is_content_class(classes);
  int currentBlock = block;
  if (starts_block(classes)) currentBlock = ++snapshot->block;
  if ([role isEqualToString:@"AXStaticText"] && withinContent && snapshot->current) {
    NSString *value = string_attribute(element, kAXValueAttribute);
    if (value.length > 0) {
      snapshot->characters += value.length;
      if (snapshot->characters > 1000000) { snapshot->truncated = YES; return; }
      [snapshot->current[@"parts"] addObject:@{ @"block": @(currentBlock), @"text": value }];
    }
  }
  if ([role isEqualToString:@"AXTextArea"]) return;
  for (id child in children_of(element)) {
    if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID()) {
      visit_transcript((__bridge AXUIElementRef)child, snapshot, depth + 1,
                       withinContent, currentBlock);
    }
    if (snapshot->truncated) break;
  }
}

NSDictionary *read_chatgpt_snapshot(AXUIElementRef app) {
  @autoreleasepool {
    CFTypeRef rawWindows = attribute(app, kAXWindowsAttribute);
    AXUIElementRef webArea = NULL;
    if (rawWindows && CFGetTypeID(rawWindows) == CFArrayGetTypeID()) {
      CFArrayRef windows = (CFArrayRef)rawWindows;
      for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
        AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
        if (CFGetTypeID(window) != AXUIElementGetTypeID()
            || ![string_attribute(window, kAXRoleAttribute) isEqualToString:@"AXWindow"]) continue;
        int budget = 12000;
        webArea = find_element(window, @"AXWebArea", nil, nil, 0, &budget);
        if (webArea) break;
      }
    }
    if (rawWindows) CFRelease(rawWindows);
    if (!webArea) { return @{ @"ok": @NO, @"error": @"No native chat web area is visible." }; }
    NSString *title = string_attribute(webArea, kAXTitleAttribute) ?: @"";
    int budget = 12000;
    AXUIElementRef main = find_element(webArea, nil, @"AXLandmarkMain", nil, 0, &budget);
    CFRelease(webArea);
    if (!main) { return @{ @"ok": @NO, @"error": @"No native chat main area is visible." }; }
    budget = 12000;
    AXUIElementRef transcript = find_element(main, nil, nil, @"_transcriptContent_", 0, &budget);
    CFRelease(main);
    if (!transcript) { return @{ @"ok": @NO, @"error": @"No ChatGPT transcript is visible." }; }
    Snapshot snapshot = { .turns = [NSMutableArray array], .current = nil,
      .block = 0, .nodesLeft = 12000, .characters = 0, .truncated = NO };
    visit_transcript(transcript, &snapshot, 0, NO, 0);
    CFRelease(transcript);
    if (!snapshot.turns.count) { return @{ @"ok": @NO, @"error": @"No verified ChatGPT speaker headings were found." }; }
    NSDictionary *output = @{ @"kind": @"chatgpt_ax_snapshot_v1", @"title": title,
      @"turns": snapshot.turns, @"truncated": @(snapshot.truncated) };
    NSData *json = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
    if (!json || json.length > 5000000) {
      return @{ @"ok": @NO, @"error": @"ChatGPT snapshot is too large or cannot be encoded." };
    }
    return @{ @"ok": @YES, @"value": output };
  }
}

static NSString *url_attribute(AXUIElementRef element) {
  CFTypeRef raw = attribute(element, CFSTR("AXURL"));
  if (!raw) return @"";
  NSString *result = @"";
  if (CFGetTypeID(raw) == CFURLGetTypeID()) result = [(__bridge NSString *)CFURLGetString((CFURLRef)raw) copy];
  else if (CFGetTypeID(raw) == CFStringGetTypeID()) result = [(__bridge NSString *)raw copy];
  CFRelease(raw);
  return result ?: @"";
}

static BOOL is_claude_chat_address(NSString *address) {
  // Some native Electron trees expose the displayed address without a scheme.
  // Normalize only the exact supported host, never a suffix or arbitrary URL.
  NSString *absolute = [address hasPrefix:@"claude.ai/"]
    ? [@"https://" stringByAppendingString:address] : address;
  NSURLComponents *url = [NSURLComponents componentsWithString:absolute];
  return [url.scheme isEqualToString:@"https"] && [url.host isEqualToString:@"claude.ai"]
    && [url.path hasPrefix:@"/chat/"];
}

static AXUIElementRef claude_web_area(AXUIElementRef element, int depth, int *budget,
                                      int *webAreas, int *chatAddresses) {
  if (depth > 48 || (*budget)-- <= 0) return NULL;
  NSString *role = string_attribute(element, kAXRoleAttribute);
  if ([role isEqualToString:@"AXWebArea"]) {
    (*webAreas)++;
    if (is_claude_chat_address(url_attribute(element))) {
      (*chatAddresses)++;
      return (AXUIElementRef)CFRetain(element);
    }
    int innerBudget = 12000;
    AXUIElementRef transcript = find_element(element, nil, nil,
                                              @"epitaxy-transcript-typography", 0, &innerBudget);
    if (transcript) { CFRelease(transcript); return (AXUIElementRef)CFRetain(element); }
    if ([url_attribute(element) containsString:@"/cowork/"]) {
      return (AXUIElementRef)CFRetain(element);
    }
  }
  if ([role isEqualToString:@"AXApplication"] && depth > 0) return NULL;
  for (id child in children_of(element)) {
    if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) continue;
    AXUIElementRef found = claude_web_area((__bridge AXUIElementRef)child, depth + 1, budget,
                                          webAreas, chatAddresses);
    if (found) return found;
  }
  return NULL;
}

static void claude_article_text(AXUIElementRef element, NSMutableArray<NSString *> *parts,
                                int depth, int *budget) {
  if (depth > 48 || (*budget)-- <= 0) return;
  NSString *role = string_attribute(element, kAXRoleAttribute);
  NSString *subrole = string_attribute(element, kAXSubroleAttribute);
  NSArray<NSString *> *classes = classes_of(element);
  if ([role isEqualToString:@"AXButton"]
      || [role isEqualToString:@"AXToolbar"] || [role isEqualToString:@"AXTextArea"]
      || [subrole isEqualToString:@"AXApplicationStatus"]
      || has_class(classes, @"sr-only") || has_class(classes, @"group/morph")) return;
  // Keep headings written in the reply; skip only the accessible speaker label.
  if ([role isEqualToString:@"AXHeading"]) {
    NSString *label = string_attribute(element, kAXTitleAttribute);
    if ([label hasPrefix:@"You said:"] || [label hasPrefix:@"Claude responded:"]) return;
  }
  if ([role isEqualToString:@"AXStaticText"]) {
    NSString *value = [string_attribute(element, kAXValueAttribute) stringByTrimmingCharactersInSet:
                       [NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (value.length) [parts addObject:value];
    return;
  }
  for (id child in children_of(element)) {
    if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID()) {
      claude_article_text((__bridge AXUIElementRef)child, parts, depth + 1, budget);
    }
  }
}

static BOOL cowork_message_label(NSString *label) {
  if (![label hasPrefix:@"Message "]) return NO;
  NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^Message [0-9]+ of [0-9]+$"
                                                                      options:0 error:nil];
  return [pattern firstMatchInString:label options:0 range:NSMakeRange(0, label.length)] != nil;
}

static AXUIElementRef find_cowork_messages(AXUIElementRef element, int depth, int *budget) {
  if (depth > 48 || (*budget)-- <= 0) return NULL;
  NSString *description = string_attribute(element, kAXDescriptionAttribute);
  NSString *title = string_attribute(element, kAXTitleAttribute);
  if ([description isEqualToString:@"Chat messages"] || [title isEqualToString:@"Chat messages"])
    return (AXUIElementRef)CFRetain(element);
  for (id child in children_of(element)) {
    if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) continue;
    AXUIElementRef found = find_cowork_messages((__bridge AXUIElementRef)child, depth + 1, budget);
    if (found) return found;
  }
  return NULL;
}

static void claude_cowork_messages(AXUIElementRef element, NSMutableArray<NSDictionary *> *turns,
                                   int depth, int *budget, BOOL *truncated) {
  if (depth > 48 || (*budget)-- <= 0 || turns.count >= 1000) { *truncated = YES; return; }
  NSString *description = string_attribute(element, kAXDescriptionAttribute);
  NSString *title = string_attribute(element, kAXTitleAttribute);
  if (cowork_message_label(description) || cowork_message_label(title)) {
    int headingBudget = 500;
    AXUIElementRef heading = find_element(element, @"AXHeading", nil, nil, 0, &headingBudget);
    NSString *label = heading ? string_attribute(heading, kAXTitleAttribute) : nil;
    if (heading) CFRelease(heading);
    NSString *speaker = nil;
    if ([label hasPrefix:@"You said:"]) speaker = @"user";
    else if ([label hasPrefix:@"Claude responded:"]) speaker = @"assistant";
    if (speaker) {
      NSMutableArray<NSString *> *parts = [NSMutableArray array];
      int textBudget = 3000;
      claude_article_text(element, parts, 0, &textBudget);
      if (textBudget <= 0) { *truncated = YES; return; }
      NSString *text = [parts componentsJoinedByString:@"\n"];
      if (text.length) [turns addObject:@{ @"role": speaker, @"text": text }];
    }
    return;
  }
  for (id child in children_of(element)) {
    if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) continue;
    claude_cowork_messages((__bridge AXUIElementRef)child, turns, depth + 1, budget, truncated);
    if (*truncated) return;
  }
}

static void claude_articles(AXUIElementRef element, NSMutableArray<NSDictionary *> *turns,
                            int depth, int *budget, BOOL *truncated) {
  if (depth > 48 || (*budget)-- <= 0 || turns.count >= 1000) { *truncated = YES; return; }
  NSString *subrole = string_attribute(element, kAXSubroleAttribute);
  if ([subrole isEqualToString:@"AXDocumentArticle"]) {
    int headingBudget = 300;
    AXUIElementRef heading = find_element(element, @"AXHeading", nil, nil, 0, &headingBudget);
    NSString *label = heading ? string_attribute(heading, kAXTitleAttribute) : nil;
    if (heading) CFRelease(heading);
    NSString *role = nil;
    if ([label hasPrefix:@"You said:"]) role = @"user";
    else if ([label hasPrefix:@"Claude responded:"]) role = @"assistant";
    if (role) {
      NSMutableArray<NSString *> *parts = [NSMutableArray array];
      int textBudget = 3000;
      claude_article_text(element, parts, 0, &textBudget);
      if (textBudget <= 0) { *truncated = YES; return; }
      NSString *text = [parts componentsJoinedByString:@"\n"];
      if (text.length) [turns addObject:@{ @"role": role, @"text": text }];
    }
    return;
  }
  for (id child in children_of(element)) {
    if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID()) {
      claude_articles((__bridge AXUIElementRef)child, turns, depth + 1, budget, truncated);
      if (*truncated) return;
    }
  }
}

NSDictionary *read_claude_snapshot(AXUIElementRef app) {
  @autoreleasepool {
    if (!AXIsProcessTrusted()) {
      return @{ @"ok": @NO, @"error": @"Enable Sherry Desktop in System Settings > Privacy & Security > Accessibility." };
    }
    // Electron may expose only an empty shell until an authorized reader asks
    // for its web accessibility tree. This does not replace the macOS grant.
    AXUIElementSetAttributeValue(app, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
    CFTypeRef rawWindows = attribute(app, kAXWindowsAttribute);
    AXUIElementRef webArea = NULL;
    int webAreas = 0, chatAddresses = 0;
    if (rawWindows && CFGetTypeID(rawWindows) == CFArrayGetTypeID()) {
      CFArrayRef windows = (CFArrayRef)rawWindows;
      for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
        AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
        if (CFGetTypeID(window) != AXUIElementGetTypeID()
            || ![string_attribute(window, kAXRoleAttribute) isEqualToString:@"AXWindow"]) continue;
        int budget = 12000;
        webArea = claude_web_area(window, 0, &budget, &webAreas, &chatAddresses);
        if (webArea) break;
      }
    }
    if (rawWindows) CFRelease(rawWindows);
    if (!webArea) { return @{ @"ok": @NO, @"error": [NSString stringWithFormat:
      @"No Claude conversation transcript is visible (%d web areas; %d recognized chat addresses).",
      webAreas, chatAddresses] }; }
    NSString *sourceURL = url_attribute(webArea);
    NSString *title = string_attribute(webArea, kAXTitleAttribute) ?: @"Claude conversation";
    BOOL cowork = [sourceURL containsString:@"/cowork/"];
    BOOL ordinaryChat = is_claude_chat_address(sourceURL);
    int budget = 12000;
    AXUIElementRef transcript = (cowork || ordinaryChat) ? find_cowork_messages(webArea, 0, &budget)
      : find_element(webArea, nil, nil, @"epitaxy-transcript-typography", 0, &budget);
    CFRelease(webArea);
    if (!transcript) { return @{ @"ok": @NO, @"error": ordinaryChat || cowork
      ? @"No Claude message list is visible (conversation address recognized)."
      : @"No Claude message list is visible (legacy transcript layout)." }; }
    NSMutableArray<NSDictionary *> *turns = [NSMutableArray array];
    BOOL truncated = NO;
    budget = 12000;
    if (cowork) claude_cowork_messages(transcript, turns, 0, &budget, &truncated);
    else {
      claude_articles(transcript, turns, 0, &budget, &truncated);
      if (!turns.count && !truncated) {
        budget = 12000;
        claude_cowork_messages(transcript, turns, 0, &budget, &truncated);
      }
    }
    CFRelease(transcript);
    if (!turns.count) { return @{ @"ok": @NO, @"error": @"No verified Claude speaker headings were found." }; }
    NSDictionary *output = @{ @"kind": @"claude_ax_snapshot_v1", @"sourceURL": sourceURL,
      @"title": title, @"turns": turns, @"truncated": @(truncated) };
    NSData *json = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
    if (!json || json.length > 5000000) {
      return @{ @"ok": @NO, @"error": @"Claude snapshot is too large or cannot be encoded." };
    }
    return @{ @"ok": @YES, @"value": output };
  }
}

static int write_snapshot_result(NSDictionary *result) {
  if (![result[@"ok"] boolValue]) {
    fprintf(stderr, "%s\n", [result[@"error"] UTF8String]);
    return 5;
  }
  NSData *json = [NSJSONSerialization dataWithJSONObject:result[@"value"] options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  return 0;
}
int write_chatgpt_snapshot(AXUIElementRef app) { return write_snapshot_result(read_chatgpt_snapshot(app)); }
int write_claude_snapshot(AXUIElementRef app) { return write_snapshot_result(read_claude_snapshot(app)); }
