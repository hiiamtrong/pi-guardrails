
type ExtensionAPI = {
  on: (event: string, handler: (event: any) => unknown) => void;
};

// Pi compacts after a run's last response without queueing anything, so the run settles and waits for the user.
export default function (pi: ExtensionAPI) {
	let compactedAtRunEnd = false;
	let resumedSinceInput = false;

	// Extensions also send prompts after each run (review hooks); only a person typing re-arms the guard.
	pi.on("input", (event) => {
		if (event.source !== "extension") resumedSinceInput = false;
	});

	pi.on("session_compact", (event) => {
		compactedAtRunEnd = event.reason === "threshold" && !event.willRetry;
	});

	// A turn that starts after compaction means pi already continued by itself.
	pi.on("turn_start", () => {
		compactedAtRunEnd = false;
	});

	// shortcut: one automatic resume per user input, so a context that stays over the threshold cannot loop; type "continue" for more.
	pi.on("agent_before_settle", (event) => {
		const resume =
			compactedAtRunEnd && event.outcome === "completed" && !resumedSinceInput && event.context.pendingMessages.length === 0;
		compactedAtRunEnd = false;
		if (!resume) return;
		resumedSinceInput = true;
		return {
			continue: true,
			entries: [
				{
					type: "custom_message",
					customType: "compact-continue",
					display: true,
					content:
						"The context was just compacted. Continue the task you were working on, starting from the summary's Next Steps. If everything is already done, reply with one short line saying so.",
				},
			],
		};
	});
}
