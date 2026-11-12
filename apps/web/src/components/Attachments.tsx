import { type AttachmentRef, maxAttachments } from "@beebot/contracts";
import { FileText, Paperclip, X } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useRef, useState } from "react";

import { uploadAttachment } from "../serverConnection";
import { iconProps } from "./ui";

type Upload = {
  key: string;
  name: string;
  progress: number;
  attachment?: AttachmentRef;
  error?: string;
};

export function fileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Files upload as soon as they're added, so sending only names them.
export function useAttachments(roomId: string) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const update = (key: string, change: Partial<Upload>) =>
    setUploads((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );

  function add(files: Iterable<File>) {
    const room = maxAttachments - uploads.length;
    for (const file of [...files].slice(0, Math.max(room, 0))) {
      const key = crypto.randomUUID();
      setUploads((current) => [...current, { key, name: file.name, progress: 0 }]);
      void uploadAttachment(roomId, file, (progress) => update(key, { progress })).then((result) =>
        update(key, result.ok ? { attachment: result.attachment } : { error: result.message }),
      );
    }
  }

  return {
    uploads,
    add,
    remove: (key: string) => setUploads((current) => current.filter((item) => item.key !== key)),
    clear: () => setUploads([]),
    ids: uploads.flatMap(({ attachment }) => (attachment ? [attachment.id] : [])),
    uploading: uploads.some(({ attachment, error }) => !attachment && !error),
    // For the form: files dropped on it, or pasted into its text box.
    onDrop: (event: DragEvent) => {
      if (event.dataTransfer.files.length > 0) {
        event.preventDefault();
        add(event.dataTransfer.files);
      }
    },
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes("Files")) {
        event.preventDefault();
      }
    },
    onPaste: (event: ClipboardEvent) => {
      if (event.clipboardData.files.length > 0) {
        event.preventDefault();
        add(event.clipboardData.files);
      }
    },
  };
}

export function AttachButton({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: FileList) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        aria-label="Attach files"
        className="button !px-2"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Paperclip {...iconProps} />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={({ currentTarget }) => {
          if (currentTarget.files) {
            onFiles(currentTarget.files);
          }
          currentTarget.value = "";
        }}
      />
    </>
  );
}

export function UploadChips({
  uploads,
  onRemove,
}: {
  uploads: Upload[];
  onRemove: (key: string) => void;
}) {
  if (uploads.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Attached files" className="flex flex-wrap gap-1 px-1">
      {uploads.map(({ key, name, progress, attachment, error }) => (
        <li
          key={key}
          className={`flex max-w-56 items-center gap-1 rounded-field border px-2 py-0.5 text-micro ${
            error ? "border-danger/40 text-danger" : "border-edge text-ink-secondary"
          }`}
          title={error}
        >
          <FileText {...iconProps} size={12} className="shrink-0" />
          <span className="truncate">{name}</span>
          <span className="shrink-0 tabular-nums">
            {error
              ? "Failed"
              : attachment
                ? fileSize(attachment.size)
                : `${Math.round(progress * 100)}%`}
          </span>
          <button
            type="button"
            aria-label={`Remove ${name}`}
            className="shrink-0 rounded-full hover:text-ink"
            onClick={() => onRemove(key)}
          >
            <X {...iconProps} size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function MessageAttachments({ attachments }: { attachments: AttachmentRef[] }) {
  return (
    <ul aria-label="Attachments" className="flex flex-wrap justify-end gap-1">
      {attachments.map(({ id, name, size }) => (
        <li
          key={id}
          className="flex max-w-56 items-center gap-1 rounded-field border border-edge px-2 py-0.5 text-micro text-ink-secondary"
        >
          <FileText {...iconProps} size={12} className="shrink-0" />
          <span className="truncate">{name}</span>
          <span className="shrink-0 tabular-nums">{fileSize(size)}</span>
        </li>
      ))}
    </ul>
  );
}
