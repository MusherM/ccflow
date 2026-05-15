import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { summaryPath, transcriptPath } from "./paths.js";
import type { FlowNode } from "./types.js";

export function newTranscriptId() {
  return randomUUID();
}

export function newSummaryId() {
  return randomUUID();
}

export function writeInitialTranscript(transcriptId: string, text: string) {
  fs.writeFileSync(transcriptPath(transcriptId), text, "utf8");
}

export function appendTranscript(transcriptId: string, text: string) {
  fs.appendFileSync(transcriptPath(transcriptId), text, "utf8");
}

export function writeSummary(summaryId: string, text: string) {
  fs.writeFileSync(summaryPath(summaryId), text, "utf8");
}

export function contextPacket(node: FlowNode) {
  return [
    "# Reconstructed CCFlow Context",
    "",
    `Node: ${node.title}`,
    `Node id: ${node.id}`,
    `Snapshot: ${node.resultCommit}`,
    `Context fidelity: ${node.contextFidelity}`,
    "",
    "Claude Code could not be resumed at a guaranteed exact turn checkpoint.",
    "Use this visible packet as recovered working context before continuing."
  ].join("\n");
}
