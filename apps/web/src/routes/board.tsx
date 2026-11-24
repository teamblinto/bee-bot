import { createFileRoute } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import { BoardPage } from "../components/BoardPage";
import { getConnectionState, subscribeToConnection } from "../serverConnection";

function Board() {
  const connection = useSyncExternalStore(subscribeToConnection, getConnectionState);
  return <BoardPage connection={connection} />;
}

export const Route = createFileRoute("/board")({ component: Board });
