import { useEffect, useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useApp } from "../../context/AppContext";

/**
 * The stored files a screen shows (`docs`), with their bytes while the
 * screen is open (AppContext requestDocumentBytes, utils/documentBytes.js):
 * the account's files are no longer all downloaded at load (2026-10-02, the
 * owner's iPhone, where they took hundreds of MB and iOS discarded the page
 * in Gmail). Asked for as the screen opens or its list changes, let go as it
 * closes. Only files with a cloud copy are asked for; one only on this
 * device has its bytes.
 */
export default function useDocumentBytes(docs) {
  const app = useApp();
  const request = app?.requestDocumentBytes;
  const release = app?.releaseDocumentBytes;
  const key = [...new Set((Array.isArray(docs) ? docs : []).filter(d => d?.id && d.storagePath).map(d => String(d.id)))].sort().join(",");
  useEffect(() => {
    if (!key || typeof request !== "function") return undefined;
    const ids = key.split(",");
    request(ids);
    return () => { if (typeof release === "function") release(ids); };
  }, [key, request, release]);
}

/**
 * Where each document's file stands on this device, as a function of the
 * document: null when its bytes are here (or there is nothing to fetch),
 * otherwise "loading", "failed" (tried again on its own) or "offline". The
 * screen renders again as downloads start, fail and land. Without the app's
 * byte store (a screen test), a stored file with no bytes is "loading".
 */
export function useDocumentFileStatus() {
  const app = useApp();
  const bytes = app?.documentBytes;
  const subscribe = useCallback((fn) => (typeof bytes?.subscribe === "function" ? bytes.subscribe(fn) : () => {}), [bytes]);
  const snapshot = useCallback(() => (typeof bytes?.version === "function" ? bytes.version() : 0), [bytes]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return useCallback((doc) => {
    if (typeof bytes?.status === "function") return bytes.status(doc);
    return doc && !doc.data && doc.storagePath && !doc.fileMissing ? "loading" : null;
  }, [bytes]);
}

/**
 * Which cards of a long list of files are on the screen or near it (within
 * `margin` px), so only their files are fetched as the list opens and scrolls
 * (Documents: the owner's ~60 files, ~74 MB, were all downloaded at once by
 * a list that asked for every one). `ref(id)` goes on each card. Where the
 * browser cannot tell (no IntersectionObserver), every card counts as shown.
 */
export function useCardsOnScreen({ margin = 600 } = {}) {
  const supported = typeof IntersectionObserver === "function";
  const [shown, setShown] = useState(() => new Set());
  const observer = useRef(null);
  const elements = useRef(new Map());   // id -> the card on screen
  const idOf = useRef(new WeakMap());   // card -> id
  const refs = useRef(new Map());       // id -> its ref callback, one per id
  useEffect(() => {
    if (!supported) return undefined;
    const io = new IntersectionObserver((entries) => {
      setShown((prev) => {
        let next = null;
        for (const entry of entries) {
          const id = idOf.current.get(entry.target);
          if (id == null || entry.isIntersecting === prev.has(id)) continue;
          next ||= new Set(prev);
          if (entry.isIntersecting) next.add(id); else next.delete(id);
        }
        return next || prev;
      });
    }, { rootMargin: `${margin}px 0px ${margin}px 0px` });
    observer.current = io;
    for (const el of elements.current.values()) io.observe(el);
    return () => { io.disconnect(); observer.current = null; };
  }, [supported, margin]);
  const ref = useCallback((id) => {
    const key = String(id);
    let fn = refs.current.get(key);
    if (!fn) {
      fn = (el) => {
        const was = elements.current.get(key);
        if (was && was !== el) { observer.current?.unobserve(was); elements.current.delete(key); }
        if (el && el !== was) {
          idOf.current.set(el, key);
          elements.current.set(key, el);
          observer.current?.observe(el);
        }
      };
      refs.current.set(key, fn);
    }
    return fn;
  }, []);
  const isShown = useCallback((id) => !supported || shown.has(String(id)), [supported, shown]);
  return { ref, isShown };
}
