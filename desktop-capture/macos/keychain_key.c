#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>

// Emits a 32-byte per-user key as hex on stdout for the parent process only.
// Nothing is written to a normal file or passed through command arguments.
static const CFStringRef service = CFSTR("com.sherry.desktop-capture.queue.v1");
static const CFStringRef account = CFSTR("default");

int main(void) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, service);
  CFDictionarySetValue(query, kSecAttrAccount, account);
  CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);

  CFTypeRef found = NULL;
  OSStatus status = SecItemCopyMatching(query, &found);
  unsigned char key[32];
  if (status == errSecItemNotFound) {
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof(key), key) != errSecSuccess) {
      fputs("Unable to generate queue key.\n", stderr);
      CFRelease(query);
      return 1;
    }
    CFMutableDictionaryRef add = CFDictionaryCreateMutable(NULL, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(add, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(add, kSecAttrService, service);
    CFDictionarySetValue(add, kSecAttrAccount, account);
    CFDataRef data = CFDataCreate(NULL, key, sizeof(key));
    CFDictionarySetValue(add, kSecValueData, data);
    status = SecItemAdd(add, NULL);
    CFRelease(data);
    CFRelease(add);
    if (status != errSecSuccess) {
      fprintf(stderr, "Unable to store queue key in Keychain (status %d).\n", (int)status);
      memset(key, 0, sizeof(key));
      CFRelease(query);
      return 1;
    }
  } else if (status == errSecSuccess && found && CFGetTypeID(found) == CFDataGetTypeID()
      && CFDataGetLength((CFDataRef)found) == sizeof(key)) {
    memcpy(key, CFDataGetBytePtr((CFDataRef)found), sizeof(key));
  } else {
    fprintf(stderr, "Unable to read queue key from Keychain (status %d).\n", (int)status);
    if (found) CFRelease(found);
    CFRelease(query);
    return 1;
  }
  for (size_t i = 0; i < sizeof(key); i++) printf("%02x", key[i]);
  putchar('\n');
  memset(key, 0, sizeof(key));
  if (found) CFRelease(found);
  CFRelease(query);
  return 0;
}
