import { type Bot, type Command, Skill, skillUsable } from "@beebot/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { postCommand } from "../serverConnection";

declare global {
  interface Window {
    // Set by the desktop app's preload. A plain browser has no folder picker.
    beeDesktop?: { pickFolder: () => Promise<string | null> };
  }
}

const labelClass = "flex flex-col gap-1 text-label text-ink-secondary";
const headingClass = "text-label text-ink-secondary";
const metaClass = "text-label text-ink-faint";

function skillLine(skill: Skill, on: boolean) {
  if (skill.sha256 === null) {
    return "Changed since review: it now holds something a skill can't. Delete it and add it again.";
  }
  if (skill.reviewedSha256 === null) {
    return "Not reviewed yet.";
  }
  if (!skillUsable(skill)) {
    return on
      ? "Changed since review, so this bot doesn't get it until you review it again."
      : "Changed since review.";
  }
  const others = skill.botIds.length - (on ? 1 : 0);
  const shared = others > 0 ? ` Also on for ${others} other ${others === 1 ? "bot" : "bots"}.` : "";
  return `${on ? "On for this bot." : "Off for this bot."}${shared}`;
}

export function SkillsPanel({
  bot,
  skills,
  connected,
  onClose,
}: {
  bot: Bot;
  skills: Skill[];
  connected: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sending = useRef(false);
  const [text, setText] = useState("");
  const [reviewing, setReviewing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, []);

  const disabled = busy || !connected;
  const review = skills.find(({ name }) => name === reviewing);

  // State updates arrive by event, so a success only has to tidy up here.
  async function send(command: Command, onDone: (body: unknown) => void = () => {}) {
    if (sending.current) {
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    sending.current = false;
    setBusy(false);
    if (result.ok) {
      onDone(result.body);
    } else {
      setError(result.message);
    }
  }

  // A new skill opens on its review: it can't be turned on before.
  const openAdded = (body: unknown) => setReviewing(Skill.safeParse(body).data?.name);

  function submit(event: FormEvent) {
    event.preventDefault();
    void send({ type: "add-skill", text }, (body) => {
      setText("");
      openAdded(body);
    });
  }

  async function addFolder() {
    const folder = await window.beeDesktop?.pickFolder();
    if (folder) {
      void send({ type: "add-skill", folder }, openAdded);
    }
  }

  function remove(skill: Skill) {
    const others = skill.botIds.filter((id) => id !== bot.id).length;
    const also = others > 0 ? ` It is also taken off ${others} other bots.` : "";
    if (window.confirm(`Delete ${skill.name} from the skill library?${also}`)) {
      void send({ type: "delete-skill", name: skill.name }, () => setReviewing(undefined));
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label={`${bot.name} skills`}
      className="dialog m-auto max-h-[80dvh] w-[min(560px,calc(100vw-32px))] flex-col gap-3 p-5 backdrop:bg-scrim open:flex"
      onClose={onClose}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold">{review ? review.name : "Skills"}</h2>
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      {review ? (
        <>
          <p className="text-small text-ink-secondary">
            A skill tells the bot how to do something, and may come with files and scripts it can
            read. Read its SKILL.md before you turn it on. Scripts still ask you before they run, as
            your Access setting says.
          </p>
          <pre className="scroller surface min-h-0 overflow-auto p-3 text-small wrap-anywhere whitespace-pre-wrap">
            {review.text}
          </pre>
          <div className="flex flex-wrap justify-end gap-1">
            <button type="button" className="button" onClick={() => setReviewing(undefined)}>
              Back
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={disabled || review.sha256 === null || skillUsable(review)}
              onClick={() =>
                void send(
                  { type: "review-skill", name: review.name, sha256: review.sha256 ?? "" },
                  () => setReviewing(undefined),
                )
              }
            >
              {skillUsable(review) ? "Reviewed" : "Mark as reviewed"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-small text-ink-secondary">
            One library for every bot. Turn on what this bot may use. Changes reach its next turn.
          </p>
          <section
            className="scroller flex min-h-0 flex-col gap-2 overflow-y-auto"
            aria-label="Library"
          >
            <h3 className={headingClass}>Library</h3>
            {skills.length === 0 && <p className="text-small text-ink-secondary">No skills yet.</p>}
            <ul className="flex flex-col gap-3">
              {skills.map((skill) => {
                const on = skill.botIds.includes(bot.id);
                return (
                  <li key={skill.name} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      aria-label={`${skill.name} on for ${bot.name}`}
                      checked={on}
                      // Off is always allowed. On needs a review of what is there now.
                      disabled={disabled || (!on && !skillUsable(skill))}
                      onChange={(event) =>
                        void send({
                          type: "set-bot-skill",
                          botId: bot.id,
                          name: skill.name,
                          on: event.target.checked,
                        })
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-name font-medium">{skill.name}</p>
                      <p className="text-small wrap-anywhere">{skill.description}</p>
                      <p className={metaClass}>{skillLine(skill, on)}</p>
                    </div>
                    <button
                      type="button"
                      className="button shrink-0"
                      onClick={() => setReviewing(skill.name)}
                    >
                      Review
                    </button>
                    <button
                      type="button"
                      className="button shrink-0"
                      disabled={disabled}
                      onClick={() => remove(skill)}
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
      {error && (
        <p role="alert" className="text-small text-ink-secondary">
          {error}
        </p>
      )}
      {!review && (
        <form className="flex shrink-0 flex-col gap-2" onSubmit={submit}>
          <label className={labelClass}>
            Add a skill: paste its SKILL.md
            <textarea
              className="field resize-none font-mono text-ink"
              rows={4}
              placeholder={
                "---\nname: my-skill\ndescription: What it does and when to use it.\n---"
              }
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            {window.beeDesktop && (
              <button
                type="button"
                className="button"
                disabled={disabled}
                onClick={() => void addFolder()}
              >
                Add a folder…
              </button>
            )}
            <button
              type="submit"
              className="button button-primary"
              disabled={disabled || !text.trim()}
            >
              Add skill
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
