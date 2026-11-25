const text = { type: "string" };
const botRef = { type: "string", description: "Bot name or id" };
const schema = (properties: Record<string, object>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const waits = " Waits for the owner unless they let leads act without asking.";

export const teamTools = [
  {
    name: "create_bot",
    description: `Creates a bot of your own, in a box on your engine.${waits}`,
    inputSchema: schema(
      {
        name: text,
        personality: text,
        model: text,
        skills: { type: "array", items: text },
        join_rooms: { type: "array", items: text, description: "Group room ids you are in" },
        first_task: { type: "string", description: "A task to delegate to it once it exists" },
      },
      ["name", "personality"],
    ),
  },
  {
    name: "update_bot",
    description: `Renames or reshapes a bot you created.${waits}`,
    inputSchema: schema(
      {
        bot_id: botRef,
        expected_version: { type: "integer", minimum: 1 },
        name: text,
        personality: text,
      },
      ["bot_id", "expected_version"],
    ),
  },
  {
    name: "archive_bot",
    description: `Archives a bot you created.${waits}`,
    inputSchema: schema({ bot_id: botRef }, ["bot_id"]),
  },
  {
    name: "create_room",
    description: `Makes a group room with you in it.${waits}`,
    inputSchema: schema(
      {
        name: text,
        members: { type: "array", items: botRef, minItems: 1, maxItems: 11 },
        default_bot: botRef,
      },
      ["name", "members"],
    ),
  },
  {
    name: "invite_to_room",
    description: `Adds a bot to a group room you are in.${waits}`,
    inputSchema: schema({ room_id: text, bot: botRef }, ["room_id", "bot"]),
  },
];

export const teamToolNames = new Set(teamTools.map(({ name }) => name));
