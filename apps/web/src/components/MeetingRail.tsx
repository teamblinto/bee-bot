import type { AgendaItem, ChatState, Meeting } from "@beebot/contracts";
import {
  CalendarClock,
  Circle,
  CircleArrowRight,
  CircleCheck,
  CircleDot,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { postCommand } from "../serverConnection";
import { tickRemaining } from "../tick";
import { Avatar } from "./Avatar";
import { iconProps } from "./ui";

const startTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

const itemIcons = {
  pending: [Circle, "text-ink-faint"],
  active: [CircleDot, "text-brand-icon"],
  done: [CircleCheck, "text-success-status"],
  deferred: [CircleArrowRight, "text-neutral-status"],
} satisfies Record<AgendaItem["status"], [LucideIcon, string]>;

export function meetingLine(meeting: Meeting) {
  if (meeting.status === "scheduled") {
    return `${meeting.title} · ${startTime.format(new Date(meeting.scheduledAt))}`;
  }
  if (meeting.status === "open") {
    return `${meeting.title} · Starting…`;
  }
  const item = meeting.agenda.find(({ id }) => id === meeting.currentItem);
  return item
    ? `${meeting.title} · ${item.title} · Round ${meeting.round} of ${meeting.maxRoundsPerItem}`
    : meeting.title;
}

const headingClass = "text-label font-medium text-ink-secondary";

function InviteCard({
  meeting,
  chat,
  connected,
}: {
  meeting: Meeting;
  chat: ChatState;
  connected: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const botOf = (botId: string) => chat.bots.find(({ id }) => id === botId);
  const facilitator = botOf(meeting.facilitatorBotId);
  const participants = meeting.participants.flatMap((id) => botOf(id) ?? []);

  async function cancel() {
    setBusy(true);
    setError(undefined);
    const result = await postCommand({ type: "cancel-meeting", meetingId: meeting.id });
    setBusy(false);
    if (!result.ok) setError(result.message);
  }

  return (
    <article className="surface flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-body-s font-medium">{meeting.title}</h3>
        <p className="flex items-center gap-1 text-caption text-ink-secondary">
          <CalendarClock {...iconProps} size={12} />
          {startTime.format(new Date(meeting.scheduledAt))} · {meeting.timeboxMin} min
        </p>
      </div>
      {facilitator && (
        <p className="flex items-center gap-2 text-body-s">
          <Avatar seed={facilitator.avatarSeed} className="size-5" />
          {facilitator.name} runs it
        </p>
      )}
      <span className="flex -space-x-1">
        {participants.map((bot) => (
          <Avatar key={bot.id} seed={bot.avatarSeed} className="size-5" />
        ))}
      </span>
      <p className="text-caption text-ink-secondary">
        {meeting.agenda.length} {meeting.agenda.length === 1 ? "agenda item" : "agenda items"}
      </p>
      {error && <p className="text-caption text-ink-secondary">{error}</p>}
      <button
        type="button"
        className="button button-sm button-outline self-start"
        disabled={busy || !connected}
        onClick={() => void cancel()}
      >
        Cancel meeting
      </button>
    </article>
  );
}

function RunningMeeting({ meeting, chat }: { meeting: Meeting; chat: ChatState }) {
  const botOf = (botId: string) => chat.bots.find(({ id }) => id === botId);
  const decisions = meeting.records.filter(({ kind }) => kind === "decision");
  const proposals = meeting.records.filter(
    ({ kind, itemId }) => kind === "proposal" && itemId === meeting.currentItem,
  );
  const choosers = (proposalId: string, option: string) =>
    meeting.records
      .filter(
        (record) =>
          record.kind === "position" &&
          record.proposalId === proposalId &&
          record.text.startsWith(`${option} — `),
      )
      .flatMap(({ ownerBotId }) => botOf(ownerBotId ?? "") ?? []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-body-s font-medium">{meeting.title}</h3>
        <p className="flex gap-2 text-caption text-ink-secondary tabular-nums">
          <span>
            Turns {meeting.turnsUsed}/{meeting.turnCap ?? "–"}
          </span>
          {meeting.endsAt && (
            <span>
              <span ref={tickRemaining(meeting.endsAt)} /> left
            </span>
          )}
        </p>
      </div>
      <ol className="flex flex-col gap-0.5">
        {meeting.agenda.map((item) => {
          const [Icon, tone] = itemIcons[item.status];
          const current = item.id === meeting.currentItem;
          return (
            <li
              key={item.id}
              aria-current={current ? "step" : undefined}
              className={`flex items-start gap-2 rounded-row px-2 py-1 text-body-s ${current ? "bg-brand-surface" : ""}`}
            >
              <Icon {...iconProps} className={`mt-0.5 shrink-0 ${tone}`} />
              <span className="flex min-w-0 flex-col">
                {item.title}
                {current && (
                  <span className="text-caption text-ink-secondary">
                    Round {meeting.round} of {meeting.maxRoundsPerItem}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {proposals.map((proposal) => (
        <section key={proposal.id} className="flex flex-col gap-1">
          <h4 className={headingClass}>Proposal</h4>
          {proposal.text && <p className="text-body-s">{proposal.text}</p>}
          <ul className="flex flex-col gap-1">
            {proposal.options.map((option) => (
              <li key={option} className="flex items-center gap-2 text-body-s">
                <span className="min-w-0 flex-1">{option}</span>
                <span className="flex shrink-0 -space-x-1">
                  {choosers(proposal.id, option).map((bot) => (
                    <Avatar key={bot.id} seed={bot.avatarSeed} className="size-5" />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {decisions.length > 0 && (
        <section className="flex flex-col gap-1">
          <h4 className={headingClass}>Decisions</h4>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-body-s">
            {decisions.map((decision) => (
              <li key={decision.id}>{decision.text}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function MeetingRail({
  meeting,
  chat,
  connected,
}: {
  meeting: Meeting;
  chat: ChatState;
  connected: boolean;
}) {
  if (meeting.status === "scheduled") {
    return <InviteCard meeting={meeting} chat={chat} connected={connected} />;
  }
  if (meeting.status === "running") {
    return <RunningMeeting meeting={meeting} chat={chat} />;
  }
  return <p className="text-body-s text-ink-secondary">Starting…</p>;
}
