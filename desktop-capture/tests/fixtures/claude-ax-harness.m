#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <unistd.h>
static BOOL trusted = YES, manual = NO;
static int modeRequests = 0;
static NSDictionary *rootNode;
static AXError testCopy(AXUIElementRef element, CFStringRef key, CFTypeRef *out) {
  NSDictionary *node = (__bridge NSDictionary *)element;
  id value = node[(__bridge NSString *)key];
  if (node == rootNode && CFEqual(key, kAXWindowsAttribute) && !manual) value = @[];
  if (!value) return kAXErrorNoValue;
  *out = CFRetain((__bridge CFTypeRef)value); return kAXErrorSuccess;
}
static AXError testSet(AXUIElementRef element, CFStringRef key, CFTypeRef value) {
  if ((__bridge NSDictionary *)element != rootNode || !CFEqual(key, CFSTR("AXManualAccessibility"))) return kAXErrorAttributeUnsupported;
  modeRequests++; manual = CFEqual(value, kCFBooleanTrue); return kAXErrorSuccess;
}
static Boolean testTrusted(void) { return trusted; }
#define AXUIElementCopyAttributeValue testCopy
#define AXUIElementSetAttributeValue testSet
#define AXUIElementGetTypeID() CFDictionaryGetTypeID()
#define AXIsProcessTrusted testTrusted
#include "../../macos/ax_snapshot.m"
static NSDictionary *article(NSString *heading, NSString *text) {
  return @{ @"AXRole": @"AXGroup", @"AXSubrole": @"AXDocumentArticle", @"AXChildren": @[
    @{ @"AXRole": @"AXHeading", @"AXTitle": heading },
    @{ @"AXRole": @"AXStaticText", @"AXValue": text }
  ] };
}
static NSDictionary *fixture(NSString *url) {
  return @{ @"AXWindows": @[@{ @"AXRole": @"AXWindow", @"AXChildren": @[
    @{ @"AXRole": @"AXWebArea", @"AXURL": url, @"AXTitle": @"Invented Claude conversation", @"AXChildren": @[
      @{ @"AXRole": @"AXGroup", @"AXDescription": @"Chat messages", @"AXChildren": @[
        article(@"You said:", @"Invented prompt"), article(@"Claude responded:", @"Invented reply")
      ] }
    ] }
  ] }] };
}
static NSDictionary *numbered_fixture(NSString *url, BOOL verifiedSpeakers) {
  return @{ @"AXWindows": @[@{ @"AXRole": @"AXWindow", @"AXChildren": @[
    @{ @"AXRole": @"AXWebArea", @"AXURL": url, @"AXTitle": @"Invented numbered conversation", @"AXChildren": @[
      @{ @"AXRole": @"AXGroup", @"AXDescription": @"Chat messages", @"AXChildren": @[
        @{ @"AXRole": @"AXGroup", @"AXDescription": @"Message 1 of 2", @"AXChildren": @[
          @{ @"AXRole": @"AXHeading", @"AXTitle": verifiedSpeakers ? @"You said: Invented prompt" : @"Unverified prompt" },
          @{ @"AXRole": @"AXStaticText", @"AXValue": @"Invented prompt" },
          @{ @"AXRole": @"AXButton", @"AXChildren": @[@{ @"AXRole": @"AXStaticText", @"AXValue": @"Hidden control label" }] }
        ] },
        @{ @"AXRole": @"AXGroup", @"AXDescription": @"Message 2 of 2", @"AXChildren": @[
          @{ @"AXRole": @"AXGroup", @"AXChildren": @[
            @{ @"AXRole": @"AXHeading", @"AXTitle": verifiedSpeakers ? @"Claude responded: Invented reply" : @"Unverified reply" },
            @{ @"AXRole": @"AXStaticText", @"AXValue": @"Invented reply" }
          ] }
        ] }
      ] }
    ] }
  ] }] };
}
int main(void) {
  @autoreleasepool {
    rootNode = fixture(@"https://claude.ai/chat/invented-id");
    trusted = NO;
    NSDictionary *denied = read_claude_snapshot((__bridge AXUIElementRef)rootNode);
    if ([denied[@"ok"] boolValue] || modeRequests != 0) { fprintf(stderr,"permission boundary failed\n");return 1; }
    trusted = YES;
    NSDictionary *result = read_claude_snapshot((__bridge AXUIElementRef)rootNode);
    NSArray *turns = result[@"value"][@"turns"];
    if (![result[@"ok"] boolValue] || modeRequests != 1 || turns.count != 2
      || ![turns[0][@"text"] isEqual:@"Invented prompt"] || ![turns[1][@"text"] isEqual:@"Invented reply"]) {
      fprintf(stderr,"reader did not request Electron mode and recover exact turns\n"); return 2;
    }
    rootNode = fixture(@"https://unrelated.example/chat/invented-id");manual = NO;
    NSDictionary *foreign = read_claude_snapshot((__bridge AXUIElementRef)rootNode);
    if ([foreign[@"ok"] boolValue]) { fprintf(stderr,"unrelated app content accepted\n");return 3; }
    for (NSString *url in @[@"https://claude.ai/chat/invented-id", @"claude.ai/chat/invented-id"]) {
      rootNode = numbered_fixture(url, YES);manual = NO;
      NSDictionary *numbered = read_claude_snapshot((__bridge AXUIElementRef)rootNode);
      NSArray *messages = numbered[@"value"][@"turns"];
      if (![numbered[@"ok"] boolValue] || messages.count != 2
        || ![messages[0][@"role"] isEqual:@"user"] || ![messages[0][@"text"] isEqual:@"Invented prompt"]
        || ![messages[1][@"role"] isEqual:@"assistant"] || ![messages[1][@"text"] isEqual:@"Invented reply"]) {
        fprintf(stderr,"ordinary numbered layout not read: %s\n",[numbered[@"error"] UTF8String]);return 4;
      }
    }
    for (NSString *url in @[@"https://claude.ai.unrelated.example/chat/id", @"claude.ai.unrelated.example/chat/id", @"http://claude.ai/chat/id", @"https://unrelated.example/chat/id"]) {
      rootNode = numbered_fixture(url, YES);manual = NO;
      if ([read_claude_snapshot((__bridge AXUIElementRef)rootNode)[@"ok"] boolValue]) {
        fprintf(stderr,"numbered layout accepted an unrelated origin\n");return 5;
      }
    }
    rootNode = numbered_fixture(@"https://claude.ai/chat/invented-id", NO);manual = NO;
    if ([read_claude_snapshot((__bridge AXUIElementRef)rootNode)[@"ok"] boolValue]) {
      fprintf(stderr,"numbered layout accepted unverified speakers\n");return 6;
    }
    puts("permission gate, Electron mode, exact turns and origin checks passed");
  }
  return 0;
}
