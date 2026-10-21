#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate>
@property (strong, nonatomic) NSStatusItem *statusItem;
@property (strong, nonatomic) NSMenu *statusMenu;
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@property (copy, nonatomic) NSString *explicitUrl;
@property (assign, nonatomic) NSInteger retryCount;
@property (assign, nonatomic) BOOL didKickstartDaemon;
@property (assign, nonatomic) BOOL startInTray;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)aNotification {
    NSArray *args = [[NSProcessInfo processInfo] arguments];
    for (NSUInteger i = 0; i < args.count; i++) {
        if ([args[i] isEqualToString:@"--url"] && i + 1 < args.count) {
            self.explicitUrl = args[i + 1];
        } else if ([args[i] isEqualToString:@"--tray"] || [args[i] isEqualToString:@"--background"]) {
            self.startInTray = YES;
        }
    }

    [self setupMainMenu];
    [self setupStatusItem];
    [self setupMainWindow];
    [self loadWebContent];
    if (self.startInTray) {
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    } else {
        [self showMainWindow];
    }
}

- (NSString *)resolveVaultUrl {
    if (self.explicitUrl.length > 0) {
        NSURL *candidate = [NSURL URLWithString:self.explicitUrl];
        if ([candidate.scheme isEqualToString:@"http"] &&
            ([candidate.host isEqualToString:@"127.0.0.1"] || [candidate.host isEqualToString:@"localhost"])) {
            return self.explicitUrl;
        }
    }

    NSString *webmcpHome = [[[NSProcessInfo processInfo] environment] objectForKey:@"WEBMCP_HOME"];
    if (!webmcpHome.length) {
        webmcpHome = [NSHomeDirectory() stringByAppendingPathComponent:@".webmcp"];
    }
    NSString *statePath = [webmcpHome stringByAppendingPathComponent:@"vault/vault-ui.json"];
    NSData *data = [NSData dataWithContentsOfFile:statePath];
    if (data) {
        NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if ([json isKindOfClass:[NSDictionary class]]) {
            NSString *urlStr = json[@"url"];
            if ([urlStr isKindOfClass:[NSString class]] && urlStr.length > 0) {
                NSString *normalized = [urlStr stringByReplacingOccurrencesOfString:@"http://0.0.0.0:" withString:@"http://127.0.0.1:"];
                normalized = [normalized stringByReplacingOccurrencesOfString:@"http://[::]:" withString:@"http://127.0.0.1:"];
                normalized = [normalized stringByReplacingOccurrencesOfString:@"http://:::" withString:@"http://127.0.0.1:"];
                return normalized;
            }
        }
    }
    return @"http://127.0.0.1:7876";
}

- (void)setupMainMenu {
    NSMenu *menubar = [[NSMenu alloc] init];
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:appMenuItem];

    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Quit WebMCP Vault" action:@selector(terminate:) keyEquivalent:@"q"];
    [appMenuItem setSubmenu:appMenu];

    NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:editMenuItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Undo" action:NSSelectorFromString(@"undo:") keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"Redo" action:NSSelectorFromString(@"redo:") keyEquivalent:@"Z"];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    [editMenuItem setSubmenu:editMenu];

    [NSApp setMainMenu:menubar];
}

- (void)setupStatusItem {
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    NSStatusBarButton *button = self.statusItem.button;
    if (button) {
        if (@available(macOS 11.0, *)) {
            NSImageSymbolConfiguration *config = [NSImageSymbolConfiguration configurationWithPointSize:13 weight:NSFontWeightSemibold];
            NSImage *icon = [[NSImage imageWithSystemSymbolName:@"lock.shield.fill" accessibilityDescription:@"WebMCP Vault"] imageWithSymbolConfiguration:config];
            if (icon) {
                icon.template = YES;
                button.image = icon;
                button.imagePosition = NSImageLeading;
                button.title = @" Vault";
            } else {
                button.title = @"🔒 Vault";
            }
        } else {
            button.title = @"🔒 Vault";
        }
        button.target = self;
        button.action = @selector(handleStatusItemClick:);
        [button sendActionOn:(NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp)];
    }

    self.statusMenu = [[NSMenu alloc] initWithTitle:@"WebMCP Vault"];
    [self.statusMenu addItemWithTitle:@"Open WebMCP Vault" action:@selector(showMainWindow) keyEquivalent:@"o"];
    [self.statusMenu addItemWithTitle:@"Reload Vault UI" action:@selector(reloadWeb) keyEquivalent:@"r"];
    [self.statusMenu addItemWithTitle:@"Open in Default Browser" action:@selector(openInBrowser) keyEquivalent:@"b"];
    [self.statusMenu addItem:[NSMenuItem separatorItem]];
    [self.statusMenu addItemWithTitle:@"Quit WebMCP Vault App" action:@selector(quitApp) keyEquivalent:@"q"];
    for (NSMenuItem *item in self.statusMenu.itemArray) {
        item.target = self;
    }
}

- (void)setupMainWindow {
    NSRect frame = NSMakeRect(0, 0, 1200, 780);
    NSUInteger styleMask = NSWindowStyleMaskTitled |
                           NSWindowStyleMaskClosable |
                           NSWindowStyleMaskMiniaturizable |
                           NSWindowStyleMaskResizable |
                           NSWindowStyleMaskFullSizeContentView;
    self.window = [[NSWindow alloc] initWithContentRect:frame styleMask:styleMask backing:NSBackingStoreBuffered defer:NO];
    [self.window setTitle:@"WebMCP Vault"];
    self.window.titlebarAppearsTransparent = YES;
    self.window.titleVisibility = NSWindowTitleHidden;
    self.window.movableByWindowBackground = NO;
    [self.window setMinSize:NSMakeSize(860, 560)];
    [self.window center];
    [self.window setDelegate:self];
    [self.window setReleasedWhenClosed:NO];

    WKWebViewConfiguration *webConfig = [[WKWebViewConfiguration alloc] init];
    WKUserContentController *contentController = [[WKUserContentController alloc] init];
    NSString *macAppScriptSource = @"document.documentElement.classList.add('is-mac-app');";
    WKUserScript *macAppScript = [[WKUserScript alloc] initWithSource:macAppScriptSource
                                                        injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                     forMainFrameOnly:YES];
    [contentController addUserScript:macAppScript];
    webConfig.userContentController = contentController;

    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:webConfig];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    [self.window.contentView addSubview:self.webView];
}

- (void)loadWebContent {
    NSURL *url = [NSURL URLWithString:[self resolveVaultUrl]];
    if (url) {
        NSURLRequest *req = [NSURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:10.0];
        [self.webView loadRequest:req];
    }
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.retryCount = 0;
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (!self.didKickstartDaemon) {
        self.didKickstartDaemon = YES;
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:@"/bin/launchctl"];
        task.arguments = @[@"start", @"io.webmcp-vault"];
        [task launchAndReturnError:nil];
    }
    if (self.retryCount < 10) {
        self.retryCount += 1;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(400 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
            [self loadWebContent];
        });
    }
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *u = navigationAction.request.URL;
    NSURL *b = [NSURL URLWithString:[self resolveVaultUrl]];
    BOOL same = [u.scheme isEqualToString:b.scheme] && [u.host isEqualToString:b.host] && ((u.port == nil && b.port == nil) || [u.port isEqual:b.port]);
    if (!same && [u.scheme hasPrefix:@"http"]) {
        [[NSWorkspace sharedWorkspace] openURL:u];
    }
    decisionHandler(same ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)navigationAction windowFeatures:(WKWindowFeatures *)windowFeatures {
    if (navigationAction.request.URL) {
        [[NSWorkspace sharedWorkspace] openURL:navigationAction.request.URL];
    }
    return nil;
}

- (void)showMainWindow {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
    [sender orderOut:nil];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    return NO;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    if (!flag) {
        [self loadWebContent];
    }
    [self showMainWindow];
    return YES;
}

- (void)handleStatusItemClick:(NSStatusBarButton *)sender {
    NSEvent *event = [NSApp currentEvent];
    if (event.type == NSEventTypeRightMouseUp) {
        [self.statusMenu popUpMenuPositioningItem:nil atLocation:NSMakePoint(0, sender.bounds.size.height + 4) inView:sender];
        return;
    }
    if (self.window.isVisible && [self.window isKeyWindow]) {
        [self.window orderOut:nil];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    } else {
        [self showMainWindow];
    }
}

- (void)reloadWeb {
    self.retryCount = 0;
    [self loadWebContent];
}

- (void)openInBrowser {
    NSURL *url = [NSURL URLWithString:[self resolveVaultUrl]];
    if (url) {
        [[NSWorkspace sharedWorkspace] openURL:url];
    }
}

- (void)quitApp {
    [NSApp terminate:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"WebMCP Vault";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert runModal];
    completionHandler();
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"WebMCP Vault";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Cancel"];
    NSModalResponse resp = [alert runModal];
    completionHandler(resp == NSAlertFirstButtonReturn);
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        BOOL trayMode = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--tray") == 0 || strcmp(argv[i], "--background") == 0) {
                trayMode = YES;
                break;
            }
        }
        NSApplication *app = [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        app.delegate = delegate;
        [app setActivationPolicy:(trayMode ? NSApplicationActivationPolicyAccessory : NSApplicationActivationPolicyRegular)];
        [app run];
    }
    return 0;
}
