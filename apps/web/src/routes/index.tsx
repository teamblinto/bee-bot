import { createFileRoute } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import {
  type ConnectionState,
  getConnectionState,
  runDiagnostic,
  subscribeToConnection,
} from "../serverConnection";

const statusLabels: Record<ConnectionState["status"], string> = {
  unconfigured: "No server. Open Bee Bot from the desktop app.",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected, retrying",
  incompatible: "Incompatible server",
};

function Home() {
  const { status, notice, events, lastCommandSeq, commandError } = useSyncExternalStore(
    subscribeToConnection,
    getConnectionState,
  );
  const roundTripDone = events.some((event) => event.seq === lastCommandSeq);

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-3xl font-bold">Bee Bot</h1>
      <p role="status" data-status={status}>
        {statusLabels[status]}
      </p>
      {notice && <p role="alert">{notice}</p>}
      <div>
        <button
          type="button"
          className="rounded border px-3 py-1 disabled:opacity-50"
          disabled={status !== "connected"}
          onClick={() => void runDiagnostic()}
        >
          Run diagnostic
        </button>
      </div>
      {roundTripDone && <p>Round trip complete: event #{lastCommandSeq} came back.</p>}
      {commandError && <p role="alert">{commandError}</p>}
      <ol className="flex flex-col gap-1 font-mono text-sm">
        {events
          .slice(-10)
          .reverse()
          .map((event) => (
            <li key={event.seq}>
              #{event.seq} {event.type} {event.createdAt}
            </li>
          ))}
      </ol>
    </main>
  );
}

export const Route = createFileRoute("/")({ component: Home });
