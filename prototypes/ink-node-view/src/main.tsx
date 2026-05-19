import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import {
  buildGraphSegments,
  moveFocus,
  nodeById,
  prototypeNodes,
  type Direction,
  type GraphSegment,
  type PrototypeNode,
  type StyleKey,
} from "../../shared/nodes.js";
import { runNativeCc } from "../../shared/nativeCc.js";

const styleMap: Record<StyleKey, Record<string, unknown>> = {
  empty: {},
  edge: { color: "#334155", dimColor: true },
  node: { color: "#dbeafe" },
  nodeDim: { color: "#64748b" },
  focus: { color: "#020617", backgroundColor: "#7dd3fc", bold: true },
  focusText: { color: "#020617", backgroundColor: "#7dd3fc", bold: true },
  selected: { color: "#111827", backgroundColor: "#facc15", bold: true },
  selectedText: { color: "#111827", backgroundColor: "#facc15", bold: true },
  live: { color: "#fbbf24", bold: true },
  active: { color: "#22c55e", bold: true },
  done: { color: "#94a3b8" },
  queued: { color: "#a78bfa" },
  conflict: { color: "#fb7185", bold: true },
};

interface AppProps {
  initialFocusId: string;
  onEnter: (node: PrototypeNode) => void;
}

function App({ initialFocusId, onEnter }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [focusId, setFocusId] = useState(initialFocusId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const focusNode = nodeById(focusId);
  const compact = columns < 112;
  const graphWidth = compact ? Math.max(58, columns - 4) : Math.max(66, Math.min(104, columns - 40));
  const graphHeight = compact ? Math.max(14, Math.min(19, rows - 8)) : Math.max(18, Math.min(24, rows - 7));
  const lines = useMemo(
    () => buildGraphSegments(graphWidth, graphHeight, focusId, selectedIds),
    [focusId, graphHeight, graphWidth, selectedIds],
  );

  useInput((input, key) => {
    const direction = inputToDirection(input, key);
    if (direction) {
      setFocusId((current) => moveFocus(current, direction));
      return;
    }

    if (key.return) {
      onEnter(focusNode);
      exit();
      return;
    }

    if (input === " ") {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(focusId)) {
          next.delete(focusId);
        } else {
          next.add(focusId);
        }
        return next;
      });
      return;
    }

    if (key.escape) {
      setSelectedIds(new Set());
      return;
    }

    if (input === "q") {
      exit();
    }
  });

  return (
    <Box flexDirection="column" width="100%" minHeight={rows}>
      <Toolbar selectedCount={selectedIds.size} />
      <Box flexDirection={compact ? "column" : "row"} flexGrow={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="#334155" paddingX={1} marginRight={1}>
          <Box marginBottom={1}>
            <Text color="#94a3b8">node graph / Ink React renderer</Text>
          </Box>
          <GraphLines lines={lines} />
        </Box>
        {compact ? (
          <CompactSummary node={focusNode} selected={selectedIds.has(focusId)} selectedCount={selectedIds.size} />
        ) : (
          <SidePanel node={focusNode} selected={selectedIds.has(focusId)} selectedCount={selectedIds.size} />
        )}
      </Box>
      <Footer />
    </Box>
  );
}

function CompactSummary({
  node,
  selected,
  selectedCount,
}: {
  node: PrototypeNode;
  selected: boolean;
  selectedCount: number;
}) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={node.accent} bold>
          {node.title}
        </Text>
        <Text color="#64748b">  {node.branch}</Text>
        <Text color={selected ? "#facc15" : "#64748b"}>  selected {selected ? "yes" : "no"}</Text>
        <Text color="#64748b">  set {selectedCount}</Text>
      </Text>
      <Text color="#94a3b8">{node.summary}</Text>
    </Box>
  );
}

function Toolbar({ selectedCount }: { selectedCount: number }) {
  return (
    <Box height={3} alignItems="center" justifyContent="space-between" borderStyle="single" borderColor="#1f2937" paddingX={1}>
      <Box>
        <Text color="#7dd3fc" bold>
          CCFlow
        </Text>
        <Text color="#e5e7eb"> node manager prototype </Text>
        <Text color="#64748b">Ink / React + Node TS</Text>
      </Box>
      <Box>
        <Text color="#94a3b8">selected </Text>
        <Text color={selectedCount ? "#facc15" : "#64748b"} bold>
          {selectedCount}
        </Text>
      </Box>
    </Box>
  );
}

function GraphLines({ lines }: { lines: GraphSegment[][] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index}>
          {line.map((segment, segmentIndex) => (
            <Text key={`${index}-${segmentIndex}`} {...styleMap[segment.style]}>
              {segment.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

function SidePanel({
  node,
  selected,
  selectedCount,
}: {
  node: PrototypeNode;
  selected: boolean;
  selectedCount: number;
}) {
  return (
    <Box width={34} flexDirection="column" borderStyle="round" borderColor={node.accent} paddingX={1}>
      <Box marginBottom={1}>
        <Text color={node.accent} bold>
          {node.title}
        </Text>
      </Box>
      <Info label="id" value={node.id} />
      <Info label="branch" value={node.branch} color={node.accent} />
      <Info label="status" value={node.status} color={node.status === "conflict" ? "#fb7185" : node.accent} />
      <Info label="selected" value={selected ? "yes" : "no"} color={selected ? "#facc15" : "#64748b"} />
      <Box marginY={1} flexDirection="column">
        <Text color="#94a3b8">summary</Text>
        <Text color="#e5e7eb">{node.summary}</Text>
      </Box>
      <Box marginBottom={1} flexDirection="column">
        <Text color="#94a3b8">files</Text>
        {node.files.map((file) => (
          <Text key={file} color="#cbd5e1">
            • {file}
          </Text>
        ))}
      </Box>
      <Text color="#94a3b8">selection set: {selectedCount}</Text>
      <Box marginTop={1}>
        <Text color="#64748b">Enter opens real cc. Esc inside cc returns here.</Text>
      </Box>
    </Box>
  );
}

function Info({ label, value, color = "#cbd5e1" }: { label: string; value: string; color?: string }) {
  return (
    <Box>
      <Box width={9}>
        <Text color="#64748b">{label}</Text>
      </Box>
      <Text color={color}>{value}</Text>
    </Box>
  );
}

function Footer() {
  return (
    <Box height={2} alignItems="center" paddingX={1}>
      <Text color="#64748b">hjkl/arrows</Text>
      <Text color="#94a3b8"> move  </Text>
      <Text color="#64748b">space</Text>
      <Text color="#94a3b8"> select  </Text>
      <Text color="#64748b">enter</Text>
      <Text color="#94a3b8"> cc  </Text>
      <Text color="#64748b">esc</Text>
      <Text color="#94a3b8"> clear/return  </Text>
      <Text color="#64748b">q</Text>
      <Text color="#94a3b8"> quit</Text>
    </Box>
  );
}

function inputToDirection(
  input: string,
  key: { leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean },
): Direction | null {
  if (key.leftArrow || input === "h") return "left";
  if (key.rightArrow || input === "l") return "right";
  if (key.upArrow || input === "k") return "up";
  if (key.downArrow || input === "j") return "down";
  return null;
}

async function main() {
  let focusId = prototypeNodes[0].id;

  while (true) {
    let enterNode: PrototypeNode | null = null;
    const instance = render(
      <App
        initialFocusId={focusId}
        onEnter={(node) => {
          enterNode = node;
          focusId = node.id;
        }}
      />,
      { exitOnCtrlC: true, alternateScreen: true },
    );

    await instance.waitUntilExit();

    if (!enterNode) {
      break;
    }

    await runNativeCc(enterNode);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
