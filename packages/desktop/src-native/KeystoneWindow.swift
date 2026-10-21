/**
 * KeystoneWindow — the native macOS thin window for the desktop shell.
 *
 * A deliberately small WKWebView host (ADR-0008, Decision H). It does exactly
 * four jobs and nothing else:
 *
 *  1. Open one titled, resizable macOS window pointing at the shell origin URL.
 *  2. Die when the window closes (the Node shell supervises this process: its
 *     exit is the signal to tear down the supervised runtime child).
 *  3. Give the web view a normal keyboard life: a standard menu bar whose
 *     Edit items route Cmd-X/C/V/A through the responder chain into web
 *     text fields, and Cmd-+/−/0 page zoom.
 *  4. Refuse to become smaller than the narrow-window breakpoint (the page
 *     itself collapses to one column below it; ADR-0008 Decision G).
 *
 * It holds no token, no config, and no task state — it only displays the URL
 * the Node shell passes on its command line.
 *
 * Build:
 *   swiftc -parse-as-library src-native/KeystoneWindow.swift -o bin/keystone-window \
 *     -framework Cocoa -framework WebKit -O
 */

import Cocoa
import WebKit

/** WebView subclass: page zoom on Cmd-+/−/0, passed through otherwise. */
final class KeystoneWebView: WKWebView {
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    guard event.modifierFlags.contains(.command), !event.modifierFlags.contains(.shift) else {
      return super.performKeyEquivalent(with: event)
    }
    switch event.charactersIgnoringModifiers {
    case "=", "+":
      zoomPage(factor: 1.1)
      return true
    case "-", "_":
      zoomPage(factor: 0.9)
      return true
    case "0":
      self.pageZoom = 1.0
      return true
    default:
      return super.performKeyEquivalent(with: event)
    }
  }

  private func zoomPage(factor: Double) {
    let next = min(2.0, max(0.5, self.pageZoom * factor))
    self.pageZoom = next
  }
}

/**
 * Delegate kept alive in a local (strong) variable: WKWebView's
 * navigationDelegate and NSWindow's delegate are weak, so without this the
 * object would be deallocated immediately and windowWillClose would never fire.
 */
final class WindowDelegate: NSObject, NSWindowDelegate, WKNavigationDelegate {
  func windowWillClose(_ notification: Notification) {
    // The user closed the only window: the shell treats this process exiting
    // as "the user closed Keystone" and tears the runtime child down.
    exit(0)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // The web content process crashed; a zombie window is worse than none.
    exit(2)
  }
}

/** A standard menu bar. Only the Edit menu matters functionally: its standard
 *  selectors route through the responder chain into the focused web view so
 *  Cmd-Z/X/C/V/A work in onboarding inputs (a bare window with no Edit menu
 *  silently breaks paste in WKWebView). */
func buildMainMenu(app: NSApplication) {
  let mainMenu = NSMenu()
  app.mainMenu = mainMenu

  // App menu
  let appMenuItem = NSMenuItem()
  mainMenu.addItem(appMenuItem)
  let appMenu = NSMenu()
  appMenuItem.submenu = appMenu
  appMenu.addItem(NSMenuItem(title: "About Keystone", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
  appMenu.addItem(.separator())
  appMenu.addItem(NSMenuItem(title: "Hide Keystone", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
  appMenu.addItem(NSMenuItem(title: "Quit Keystone", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))

  // Edit menu — standard selectors, target nil → responder chain → web view.
  let editMenuItem = NSMenuItem()
  mainMenu.addItem(editMenuItem)
  let editMenu = NSMenu(title: "Edit")
  editMenuItem.submenu = editMenu
  editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
  editMenu.addItem(NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z"))
  editMenu.addItem(.separator())
  editMenu.addItem(NSMenuItem(title: "Cut", action: Selector(("cut:")), keyEquivalent: "x"))
  editMenu.addItem(NSMenuItem(title: "Copy", action: Selector(("copy:")), keyEquivalent: "c"))
  editMenu.addItem(NSMenuItem(title: "Paste", action: Selector(("paste:")), keyEquivalent: "v"))
  editMenu.addItem(NSMenuItem(title: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a"))

  // Window menu
  let windowMenuItem = NSMenuItem()
  mainMenu.addItem(windowMenuItem)
  let windowMenu = NSMenu(title: "Window")
  windowMenuItem.submenu = windowMenu
  windowMenu.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
  windowMenu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
  windowMenu.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
}

var args = CommandLine.arguments
var urlString: String?
var title = "Keystone"
var width = 1200.0
var height = 800.0

var i = 1
while i < args.count {
  switch args[i] {
  case "--title":
    i += 1
    if i < args.count { title = args[i] }
  case "--width":
    i += 1
    if i < args.count, let w = Double(args[i]) { width = w }
  case "--height":
    i += 1
    if i < args.count, let h = Double(args[i]) { height = h }
  default:
    if urlString == nil { urlString = args[i] }
  }
  i += 1
}

guard let urlString, let url = URL(string: urlString) else {
  FileHandle.standardError.write("usage: KeystoneWindow <url> [--title t] [--width w] [--height h]\n".data(using: .utf8)!)
  exit(64)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
buildMainMenu(app: app)

let rect = NSRect(x: 0, y: 0, width: width, height: height)
let window = NSWindow(
  contentRect: rect,
  styleMask: [.titled, .closable, .miniaturizable, .resizable],
  backing: .buffered,
  defer: false
)
// Narrow-window floor: below this the page collapses (CSS @media) anyway; we
// never let the window get so narrow that the simple-mode composer is unusable.
window.minSize = NSSize(width: 360, height: 480)
window.title = title
window.center()

let delegate = WindowDelegate()
let config = WKWebViewConfiguration()
let webView = KeystoneWebView(frame: window.contentView!.bounds, configuration: config)
webView.autoresizingMask = [.width, .height]
webView.allowsBackForwardNavigationGestures = true
// Tab reaches links/form controls when Full Keyboard Access is on; the Edit
// menu supplies the standard editing shortcuts inside web text fields.
webView.navigationDelegate = delegate
window.contentView?.addSubview(webView)
window.delegate = delegate

window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
webView.load(URLRequest(url: url))

app.run()
