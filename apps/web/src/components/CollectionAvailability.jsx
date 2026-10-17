import { useEffect, useState } from "react";
import {
  fetchCollectionStatus,
  fetchRun,
  sourceNames,
  subscribeCollectionRuns,
} from "../api.js";

const idleView = (/** @type {boolean|null} */ enabled) => ({
  state: enabled === null ? "unavailable" : enabled ? "enabled" : "disabled",
  label:
    enabled === null
      ? "Collection status unavailable"
      : enabled
        ? "Fresh collection available"
        : "Fresh collection paused",
});

export default function CollectionAvailability() {
  const [view, setView] = useState({
    state: "loading",
    label: "Checking collection status…",
  });
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    /** @type {boolean|null} */ let enabled = null;
    /** @type {import('../api.js').ActiveRun|null} */ let tracked = null;
    /** @type {{state:string,label:string}|null} */ let completion = null;
    /** @type {AbortController|null} */ let controller = null;
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let completionTimer;

    function schedule(milliseconds = tracked ? 1500 : 5000) {
      clearTimeout(timer);
      if (!disposed && !document.hidden)
        timer = setTimeout(() => void refresh(), milliseconds);
    }
    function cancelRequest() {
      generation++;
      controller?.abort();
      clearTimeout(timer);
    }
    /** @param {import('../api.js').Run} run */
    function finish(run) {
      cancelRequest();
      tracked = null;
      completion = {
        state: run.status === "succeeded" ? "succeeded" : "failed",
        label: `${sourceNames[run.source]} collection ${run.status === "succeeded" ? "complete" : "failed"}`,
      };
      setView(completion);
      clearTimeout(completionTimer);
      completionTimer = setTimeout(() => {
        completion = null;
        if (!disposed) setView(idleView(enabled));
      }, 10_000);
      schedule();
    }
    /** @param {import('../api.js').ActiveRun} run */
    function collecting(run) {
      tracked = run;
      completion = null;
      clearTimeout(completionTimer);
      setView({
        state: "running",
        label: `Collecting ${sourceNames[run.source]}…`,
      });
    }
    async function refresh() {
      if (disposed || document.hidden) return;
      cancelRequest();
      const current = generation;
      const request = new AbortController();
      controller = request;
      const deadline = setTimeout(() => request.abort(), 8000);
      try {
        const status = await fetchCollectionStatus(request.signal);
        if (disposed || current !== generation) return;
        enabled = status.enabled;
        if (status.activeRun) collecting(status.activeRun);
        else if (tracked) {
          const observed = tracked;
          const run = await fetchRun(observed.id, request.signal);
          if (disposed || current !== generation) return;
          if (run.source !== observed.source || run.status === "running")
            setView(idleView(null));
          else finish(run);
        } else setView(completion ?? idleView(enabled));
      } catch {
        if (!disposed && current === generation) {
          enabled = null;
          setView(idleView(null));
        }
      } finally {
        clearTimeout(deadline);
        if (!disposed && current === generation) schedule();
      }
    }
    const unsubscribe = subscribeCollectionRuns(({ run, admitted }) => {
      if (disposed || (!admitted && run.id !== tracked?.id)) return;
      if (!admitted && run.source !== tracked?.source) {
        cancelRequest();
        setView(idleView(null));
        schedule();
        return;
      }
      if (run.status === "running") {
        if (admitted) {
          cancelRequest();
          collecting({ id: run.id, source: run.source });
          schedule(0);
        }
      } else finish(run);
    });
    const onVisible = () => {
      if (document.hidden) cancelRequest();
      else void refresh();
    };
    const onFocus = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    void refresh();
    return () => {
      disposed = true;
      cancelRequest();
      clearTimeout(completionTimer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return (
    <span
      className={`collection-availability collection-availability--${view.state}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="status-dot" aria-hidden="true" />
      {view.label}
    </span>
  );
}
