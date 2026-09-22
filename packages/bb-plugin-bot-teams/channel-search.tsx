import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { RoomMessage, rpcContract } from "./contract";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { ErrorMessage, message } from "./bot-ui";
import { Modal } from "./channel-controls";

export function ChannelSearch({
  id,
  open,
  onOpenChange,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RoomMessage[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => {
    const seq = ++request.current;
    setResults([]);
    setBefore(null);
    setError(null);
    if (!open || !query.trim()) {
      setPending(false);
      return;
    }
    setPending(true);
    const timer = setTimeout(() => {
      rpc
        .call("history", { id, query, limit: 30 })
        .then(
          (page) => {
            if (seq !== request.current) return;
            setResults([...page.messages].reverse());
            setBefore(page.nextBefore);
          },
          (e) => {
            if (seq === request.current) setError(message(e));
          },
        )
        .finally(() => {
          if (seq === request.current) setPending(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [id, query, open, rpc]);
  const more = async () => {
    if (!before || pending) return;
    const seq = request.current;
    setPending(true);
    try {
      const page = await rpc.call("history", { id, query, before, limit: 30 });
      if (seq === request.current) {
        setResults((r) => [...r, ...[...page.messages].reverse()]);
        setBefore(page.nextBefore);
      }
    } catch (e) {
      if (seq === request.current) setError(message(e));
    } finally {
      if (seq === request.current) setPending(false);
    }
  };
  return (
    <Modal title="Search channel" open={open} onOpenChange={onOpenChange}>
      <Input
        autoFocus
        aria-label="Search channel history"
        placeholder="Search messages or names…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div
        className="channel-search-results"
        role="region"
        aria-label="Search results"
      >
        {results.map((m) => (
          <button
            key={m.id}
            className="channel-search-result"
            onClick={() => {
              onOpenChange(false);
              window.dispatchEvent(
                new CustomEvent("bb:bots:jump", {
                  detail: { roomId: id, messageId: m.id },
                }),
              );
            }}
          >
            <span className="flex justify-between gap-3">
              <strong>{m.speaker}</strong>
              <time className="text-xs text-muted-foreground">
                {new Date(m.createdAt).toLocaleString()}
              </time>
            </span>
            <span className="line-clamp-3 whitespace-pre-wrap">
              {m.text || "Attachment"}
            </span>
          </button>
        ))}
      </div>
      <ErrorMessage error={error} />
      <p role="status" className="text-xs text-muted-foreground">
        {pending
          ? "Searching…"
          : !query.trim()
            ? "Search the entire channel, including older messages."
            : !results.length
              ? "No matching messages."
              : `${results.length} ${results.length === 1 ? "message" : "messages"}${before ? " · more available" : ""}`}
      </p>
      {before && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={more}>
          More results
        </Button>
      )}
    </Modal>
  );
}
