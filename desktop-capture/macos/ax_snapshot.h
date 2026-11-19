#ifndef SHERRY_AX_SNAPSHOT_H
#define SHERRY_AX_SNAPSHOT_H

#include <ApplicationServices/ApplicationServices.h>
#ifdef __OBJC__
#import <Foundation/Foundation.h>

// In-memory result for the permission-owning GUI process. No transcript files.
NSDictionary *read_chatgpt_snapshot(AXUIElementRef app);
NSDictionary *read_claude_snapshot(AXUIElementRef app);
#endif

// Writes one JSON object to stdout. Conversation text is never logged to stderr.
int write_chatgpt_snapshot(AXUIElementRef app);
int write_claude_snapshot(AXUIElementRef app);

#endif
