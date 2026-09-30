/**
 * Host-side half of the GitStudio localization seam.
 *
 * VS Code gives an extension one localized bundle per display language, at
 * `vscode.l10n.uri` (declared by the `"l10n"` field in package.json). This
 * module turns that resource into the two things the extension needs:
 *
 *  1. a configured `@vscode/l10n` runtime, so the shared, host-agnostic
 *     packages (engine, git-service, ai, webview-ui, merge-vscode) can call
 *     `l10n.t(...)` from inside the extension host process, and
 *  2. an inline `<script>` snippet that ships the very same bundle into every
 *     webview page (the strict webview CSP forbids fetching it at runtime, so
 *     it has to travel inside the HTML).
 *
 * When VS Code runs in English — or in a language we have no bundle for —
 * `vscode.l10n.uri` is `undefined`, nothing is configured, and `l10n.t()`
 * falls back to the English source string. There is deliberately no other
 * switch: the display language VS Code is already running in is the language
 * GitStudio renders in.
 *
 * The webview half lives in `@gitstudio/l10n/webview`, which must stay free of
 * Node built-ins so it can be bundled for the browser.
 */
import { readFileSync } from "node:fs";

import { config } from "@vscode/l10n";
import type { l10nJsonFormat } from "@vscode/l10n";

/** Raw bundle text as read from disk, ready to be embedded in a page. */
let bundleText: string | undefined;

/** The language the bundle was written for, e.g. `zh-cn`. */
let locale: string | undefined;

/** Set once a webview page has been handed the bundle (avoids rebuilding it). */
let scriptCache: { nonce: string; html: string } | undefined;

/**
 * Load the localized bundle for the running VS Code display language.
 *
 * Safe to call with `undefined` (English / unknown locale): the runtime is then
 * simply left unconfigured and every `l10n.t()` returns its English source.
 *
 * @param uri - `vscode.l10n.uri`, or anything with a filesystem path.
 */
export function configureL10n(uri: { fsPath: string } | undefined): void {
  bundleText = undefined;
  locale = undefined;
  scriptCache = undefined;
  if (!uri) {
    return;
  }
  try {
    const text = readFileSync(uri.fsPath, "utf8");
    config({ contents: text });
    bundleText = text.trim();
    // `…/bundle.l10n.zh-cn.json` — the same name VS Code builds from its
    // display language.
    locale = /bundle\.l10n\.([^.]+)\.json$/.exec(uri.fsPath)?.[1];
  } catch {
    // A malformed or unreadable bundle must never break activation.
    bundleText = undefined;
  }
}

/**
 * The page global that translates one message with `{0}`-style placeholders.
 *
 * It is what the extension's own inline programs call: the pages that carry a
 * whole webview program inside a `String.raw` template literal (Changes, the
 * rebase workbench, Compare, the AI report) are authored in this repo's source,
 * but they *run* in the page — so they cannot import `@vscode/l10n` and cannot
 * be translated when the host builds the HTML. They call `l10nT("…", arg)`
 * instead, and this helper resolves it against the bundle that travels with the
 * page. In English the bundle is empty and the message is handed straight back.
 *
 * Written in ES5 on purpose: it is inlined into `<script>` in a page whose CSP
 * allows no build step of its own, and it must survive whatever the page's own
 * inline program does with `var` and function scope.
 */
function webviewHelper(bundle: string, language: string | undefined): string {
  const lang = language
    ? `globalThis.__gitstudioLocale="${language}";
try{if(document&&document.documentElement){document.documentElement.setAttribute("lang",globalThis.__gitstudioLocale);}}catch(e){}
`
    : "";
  return `${lang}globalThis.__gitstudioL10n=${bundle};
globalThis.l10nT=function(message){
var args=Array.prototype.slice.call(arguments,1);
var hit=(globalThis.__gitstudioL10n||{})[message];
var text=typeof hit==="string"?hit:(hit&&hit.message)||message;
var i,key;
if(args.length===1&&args[0]!==null&&typeof args[0]==="object"){
for(key in args[0]){text=text.split("{"+key+"}").join(String(args[0][key]));}
return text;
}
for(i=0;i<args.length;i++){text=text.split("{"+i+"}").join(String(args[i]));}
return text;
};`;
}

/**
 * The inline script that hands the localized bundle to a webview page.
 *
 * Inject the result BEFORE the first `<script src="...">` of the page; the
 * webview half (`@gitstudio/l10n/webview`) picks the global up while it is
 * being imported, so no entry point needs to wire anything by hand.
 *
 * Always emitted, English included: the page's inline program calls `l10nT` for
 * every user-facing word whether or not a translation exists, so the helper has
 * to be there to hand the message back.
 *
 * @param nonce - The page's CSP nonce (`getNonce()`).
 */
export function l10nWebviewScript(nonce: string): string {
  if (scriptCache?.nonce !== nonce) {
    scriptCache = {
      nonce,
      html: `<script nonce="${nonce}">${webviewHelper(bundleText ?? "{}", locale)}</script>`,
    };
  }
  return scriptCache.html;
}

/** The parsed bundle, for tests and diagnostics. `undefined` in English. */
export function currentBundle(): l10nJsonFormat | undefined {
  if (!bundleText) {
    return undefined;
  }
  try {
    return JSON.parse(bundleText) as l10nJsonFormat;
  } catch {
    return undefined;
  }
}
