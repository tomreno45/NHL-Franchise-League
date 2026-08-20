import StarRating from "./StarRating";

// Mirrors server/data.js's ATTRIBUTE_CATEGORIES, with display labels matching
// the NHL26 player card (see Reference/NHL26 STATS.jpeg).
const SKATER_CATEGORIES = [
  {
    label: "Puck Skills",
    attrs: [
      ["deking", "Deking"],
      ["handEye", "Hand-Eye"],
      ["passing", "Passing"],
      ["puckControl", "Puck Control"],
    ],
  },
  {
    label: "Senses",
    attrs: [
      ["discipline", "Discipline"],
      ["offAwareness", "Off. Awareness"],
      ["poise", "Poise"],
    ],
  },
  {
    label: "Shooting",
    attrs: [
      ["slapShotAccuracy", "Slap Shot Accuracy"],
      ["slapShotPower", "Slap Shot Power"],
      ["wristShotAccuracy", "Wrist Shot Accuracy"],
      ["wristShotPower", "Wrist Shot Power"],
    ],
  },
  {
    label: "Defense",
    attrs: [
      ["defAwareness", "Def. Awareness"],
      ["faceoffs", "Faceoffs"],
      ["shotBlocking", "Shot Blocking"],
      ["stickChecking", "Stick Checking"],
    ],
  },
  {
    label: "Skating",
    attrs: [
      ["acceleration", "Acceleration"],
      ["agility", "Agility"],
      ["balance", "Balance"],
      ["endurance", "Endurance"],
      ["speed", "Speed"],
    ],
  },
  {
    label: "Physical",
    attrs: [
      ["aggressiveness", "Aggressiveness"],
      ["bodyChecking", "Body Checking"],
      ["durability", "Durability"],
      ["fightingSkill", "Fighting Skill"],
      ["strength", "Strength"],
    ],
  },
];

// Mirrors server/data.js's GOALIE_ATTRIBUTE_CATEGORIES (see Reference/NHL26 Goalie Stats.webp).
const GOALIE_CATEGORIES = [
  {
    label: "Low",
    attrs: [
      ["gloveLow", "Glove Low"],
      ["stickLow", "Stick Low"],
      ["fiveHole", "Five-Hole"],
    ],
  },
  {
    label: "Hands",
    attrs: [
      ["gloveHigh", "Glove High"],
      ["stickHigh", "Stick High"],
      ["passing", "Passing"],
    ],
  },
  {
    label: "Quickness",
    attrs: [
      ["speed", "Speed"],
      ["agility", "Agility"],
      ["pokeCheck", "Poke Check"],
      ["durability", "Durability"],
      ["endurance", "Endurance"],
    ],
  },
  {
    label: "Positioning",
    attrs: [
      ["reboundControl", "Rebound Control"],
      ["vision", "Vision"],
      ["breakaway", "Breakaway"],
      ["angles", "Angles"],
      ["recover", "Recover"],
    ],
  },
];

function categoryStars(attributes, keys) {
  const avg = keys.reduce((sum, [key]) => sum + attributes[key], 0) / keys.length;
  return Math.max(0.5, Math.min(5, Math.round(((avg / 99) * 5) * 2) / 2));
}

export default function PlayerAttributes({ player }) {
  const categories = player.position === "G" ? GOALIE_CATEGORIES : SKATER_CATEGORIES;

  return (
    <div className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
      {categories.map((cat) => (
        <div key={cat.label}>
          <div className="mb-1 flex items-center justify-between border-b border-slate-800 pb-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-sky-400">{cat.label}</span>
            <StarRating value={categoryStars(player.attributes, cat.attrs)} colorClass="fill-sky-400" />
          </div>
          {cat.attrs.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between py-0.5 text-sm">
              <span className="text-slate-400">{label}</span>
              <span className="text-slate-100">{player.attributes[key]}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
