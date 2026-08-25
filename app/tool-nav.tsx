"use client";

/**
 * Tab row shared by the two tools, rendered directly under the navy header
 * strip on both pages. Plain anchors and the existing Tailwind setup — no new
 * dependency, and nothing about either page's structure changes.
 */

// Brand palette, matching the Word generators and both page headers.
const NAVY = "#1B365D";
const TEAL = "#4A90A4";
const LIGHT_TEAL = "#DCE9EE";

export type ToolTab = "data" | "analysis";

const TABS: Array<{ id: ToolTab; href: string; label: string }> = [
  { id: "data", href: "/", label: "Data Report" },
  { id: "analysis", href: "/analysis", label: "Clinical Analysis" },
];

export default function ToolNav({ active }: { active: ToolTab }) {
  return (
    <nav
      aria-label="Tools"
      className="w-full border-b"
      style={{ borderColor: `${NAVY}22`, backgroundColor: `${LIGHT_TEAL}66` }}
    >
      <div className="mx-auto flex max-w-2xl gap-1 px-6">
        {TABS.map(({ id, href, label }) => {
          const isActive = id === active;
          return (
            <a
              key={id}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className="px-4 py-2.5 text-sm font-semibold transition-colors"
              style={
                isActive
                  ? {
                      color: NAVY,
                      backgroundColor: "#FFFFFF",
                      borderTop: `3px solid ${TEAL}`,
                      borderLeft: `1px solid ${NAVY}22`,
                      borderRight: `1px solid ${NAVY}22`,
                      marginBottom: "-1px",
                    }
                  : {
                      color: NAVY,
                      opacity: 0.65,
                      borderTop: "3px solid transparent",
                    }
              }
            >
              {label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
