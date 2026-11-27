import { api } from './api';

export function isNativeMac(): boolean {
  return Boolean(window.__KB_NATIVE_MAC__);
}

export function isNativeWin(): boolean {
  return Boolean(window.__KB_NATIVE_WIN__);
}

export function isWindowsPlatform(): boolean {
  if (window.__KB_NATIVE_WIN__) return true;
  if (window.__KB_NATIVE_MAC__) return false;
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    const plat = navigator.platform || '';
    return /Win/i.test(plat) || /Windows/i.test(ua);
  }
  return false;
}

export function modKeyLabel(): string {
  return isWindowsPlatform() ? 'Ctrl+' : '⌘';
}

export function fileManagerName(): string {
  return isWindowsPlatform() ? '资源管理器' : '访达';
}

export function hasNativeDesktopPicker(): boolean {
  return Boolean(
    (window.__KB_NATIVE_MAC__ && window.webkit?.messageHandlers?.kbNative) ||
      (window.__KB_NATIVE_WIN__ && window.pywebview?.api?.pick_paths)
  );
}

/**
 * Unified cross-platform file/folder picker:
 * - macOS native shell: dispatches WKWebView NSOpenPanel (supports mixed files + folders)
 * - Windows native shell: calls pywebview native Win32/WebView2 dialog
 * - Plain browser fallback: calls local backend tkinter dialog, or falls back to manual path input
 */
export async function triggerPathPicker(
  mode: 'any' | 'files' | 'folder'
): Promise<'native_async' | 'handled' | 'fallback_manual'> {
  if (window.__KB_NATIVE_MAC__ && window.webkit?.messageHandlers?.kbNative) {
    const type = mode === 'files' ? 'pickFiles' : mode === 'folder' ? 'pickFolder' : 'pickAny';
    window.webkit.messageHandlers.kbNative.postMessage({ type });
    return 'native_async';
  }

  if (window.__KB_NATIVE_WIN__ && window.pywebview?.api?.pick_paths) {
    try {
      const winMode = mode === 'folder' ? 'folder' : 'files';
      const paths = await window.pywebview.api.pick_paths(winMode);
      if (Array.isArray(paths) && paths.length > 0) {
        await (window as any).__kbOnPathsPicked?.(paths);
      }
      return 'handled';
    } catch {
      return 'fallback_manual';
    }
  }

  // Browser fallback (e.g. local python backend + Chrome/Edge on Windows/macOS/Linux)
  try {
    const res = await api.systemPickPaths(mode === 'folder' ? 'folder' : 'files');
    if (res.ok) {
      if (Array.isArray(res.paths) && res.paths.length > 0) {
        await (window as any).__kbOnPathsPicked?.(res.paths);
      }
      return 'handled';
    }
  } catch {
    // Fall through to manual path input
  }
  return 'fallback_manual';
}
