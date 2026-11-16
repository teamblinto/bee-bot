import { type Bot, type Command, Skill, skillUsable } from "@beebot/contracts";
import { BookOpen, ChevronLeft } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";

import { postCommand } from "../serverConnection";
import {
  checkboxClass,
  ConfirmDialog,
  EmptyState,
  errorClass,
  fieldLabelClass,
  RowMenu,
  SidePanel,
} from "./SidePanel";
import { iconProps } from "./ui";

const metaClass = "text-caption text-ink-secondary";

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
  const sending = useRef(false);
  const [text, setText] = useState("");
  const [reviewing, setReviewing] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const disabled = busy || !connected;
  const review = skills.find(({ name }) => name === reviewing);
  const deletingSkill = skills.find(({ name }) => name === deleting);
  const others = deletingSkill?.botIds.filter((id) => id !== bot.id).length ?? 0;

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

  const alert = error && (
    <p role="alert" className={errorClass}>
      {error}
    </p>
  );

  return (
    <SidePanel
      label={`${bot.name} skills`}
      botName={bot.name}
      title={review ? review.name : "Skills"}
      onClose={onClose}
      footer={
        review && (
          <>
            <button type="button" className="button" onClick={() => setReviewing(undefined)}>
              <ChevronLeft {...iconProps} />
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
          </>
        )
      }
    >
      {review ? (
        <>
          <p className="text-body-s text-ink-secondary">
            A skill tells the bot how to do something, and may come with files and scripts it can
            read. Read its SKILL.md before you turn it on. Scripts still ask you before they run, as
            your Access setting says.
          </p>
          <pre className="rounded-card border border-edge-subtle bg-code p-3 font-mono text-code wrap-anywhere whitespace-pre-wrap">
            {review.text}
          </pre>
          {alert}
        </>
      ) : (
        <>
          <p className="text-body-s text-ink-secondary">
            One library for every bot. Turn on what this bot may use. Changes reach its next turn.
          </p>
          <section className="flex flex-col gap-4" aria-label="Library">
            {skills.length === 0 ? (
              <EmptyState icon={BookOpen} title="No skills yet">
                <p className="text-body-s text-ink-secondary">
                  Paste a SKILL.md below to add one to the library.
                </p>
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-4">
                {skills.map((skill) => {
                  const on = skill.botIds.includes(bot.id);
                  return (
                    <li
                      key={skill.name}
                      className="flex items-start gap-3 border-b border-edge-subtle pb-4"
                    >
                      <input
                        type="checkbox"
                        className={checkboxClass}
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
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <p className="text-body-s font-medium wrap-anywhere">{skill.name}</p>
                        <p className="text-body-s wrap-anywhere text-ink-secondary">
                          {skill.description}
                        </p>
                        <p className={metaClass}>{skillLine(skill, on)}</p>
                      </div>
                      <button
                        type="button"
                        className="button button-sm shrink-0"
                        onClick={() => setReviewing(skill.name)}
                      >
                        Review
                      </button>
                      <RowMenu
                        label={`${skill.name} actions`}
                        items={[
                          {
                            label: "Delete",
                            danger: true,
                            disabled,
                            onSelect: () => setDeleting(skill.name),
                          },
                        ]}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {alert}
          <form className="flex flex-col gap-2" onSubmit={submit}>
            <label className={fieldLabelClass}>
              Add a skill: paste its SKILL.md
              <textarea
                className="field resize-none font-mono text-code font-normal"
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
                  className="button button-outline"
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
        </>
      )}
      {deletingSkill && (
        <ConfirmDialog
          title={`Delete ${deletingSkill.name}?`}
          confirmLabel="Delete"
          onConfirm={() =>
            void send({ type: "delete-skill", name: deletingSkill.name }, () =>
              setReviewing(undefined),
            )
          }
          onClose={() => setDeleting(undefined)}
        >
          {`It is removed from the skill library.${others > 0 ? ` It is also taken off ${others} other ${others === 1 ? "bot" : "bots"}.` : ""}`}
        </ConfirmDialog>
      )}
    </SidePanel>
  );
}
