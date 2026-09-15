import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ExtensionAPI,
	getMarkdownTheme,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { notifyTerminal, safeTerminalText } from "./errors.js";
import { goalBudgetTokens } from "./accounting.js";
import {
	formatStatus,
	GOAL_BLOCKED_TOOL,
	GOAL_COMPLETE_TOOL,
	GOAL_CONTINUE_TOOL,
	GOAL_WAIT_TOOL,
	type GoalRuntime,
	goalIdRejectionReason,
	isContradictoryCompletionSummary,
	MAX_GOAL_ID_LENGTH,
	STATUS_KEY,
	transitionGoal,
	truncateNotification,
} from "./runtime.js";
import {
	createGoalWait,
	MAX_GOAL_WAIT_DELAY_MS,
	MAX_GOAL_WAIT_REASON_LENGTH,
	MIN_GOAL_WAIT_DELAY_MS,
	resolveGoalWaitDelay,
} from "./wait.js";

import {
	digest,
	REVIEW_LIMITS,
	reviewEvidence,
	reviewFilesCurrent,
	runCompletionReview,
} from "./reviewer.js";

interface GoalCompleteDetails {
	goal: string;
	goal_id: string;
	summary: string;
}

interface GoalBlockedDetails {
	goal: string;
	goal_id: string;
	reason: string;
	evidence: string;
	repeated_turns: number;
}

interface GoalWaitDetails {
	goal: string;
	goal_id: string;
	reason: string;
	requested_resume_after_ms?: number;
	resume_after_ms?: number;
	resume_at?: number;
}

const MAX_GOAL_TEXT_LENGTH = 4_000;
const MAX_COMPLETION_SUMMARY_LENGTH = 4_000;
const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;

export function registerGoalTools(
	pi: ExtensionAPI,
	runtime: GoalRuntime,
	review = runCompletionReview,
) {
	pi.registerTool(
		defineTool({
			name: GOAL_CONTINUE_TOOL,
			label: "Goal Continue",
			description:
				"End the current active Goal execution segment with one concrete next action. Call alone, only with the latest active goal_id. This allows one Goal-owned continuation, not new permissions or proof of progress. Tool visibility alone does not activate Goal mode. Missing decision: pause without an automatic repair turn.",
			parameters: Type.Object({
				goal_id: Type.String({ minLength: 1, maxLength: MAX_GOAL_ID_LENGTH }),
				next_action: Type.String({ minLength: 1, maxLength: 2000 }),
			}),
			executionMode: "sequential",
			async execute(_id, params) {
				const nextAction = params.next_action.trim();
				if (
					!nextAction ||
					nextAction.length > 2000 ||
					!runtime.acceptContinuation(params.goal_id, nextAction)
				)
					return {
						content: toolContent(
							runtime.activeGoal
								? "Goal continuation rejected: no matching owned active run, or a decision already exists."
								: "Goal continuation rejected: no active goal.",
						),
						details: { goal_id: params.goal_id, next_action: nextAction },
						terminate: false,
					};
				return {
					content: toolContent("One continuation decision accepted. Stop this execution segment."),
					details: { goal_id: params.goal_id, next_action: nextAction },
					terminate: true,
				};
			},
		}),
	);
	const goalCompleteTool = defineTool({
		name: GOAL_COMPLETE_TOOL,
		label: "Goal Complete",
		executionMode: "sequential",
		description:
			"Mark an active /goal complete only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and every requirement is verified. Tool visibility alone does not activate Goal mode. Call alone. By default this submits the claim to a bounded file-only reviewer using the selected model and additional provider usage. Never call for ordinary work, partial progress, blockers, failures, or unverified work.",
		parameters: Type.Object({
			goal_id: Type.String({
				minLength: 1,
				maxLength: MAX_GOAL_ID_LENGTH,
				description:
					"The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
			}),
			summary: Type.String({
				minLength: 1,
				maxLength: MAX_COMPLETION_SUMMARY_LENGTH,
				description:
					"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
			}),
		}),
		renderResult(result) {
			return renderGoalCompletion(result);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const completedGoal = runtime.activeGoal;
			const goal = completedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const summary = typeof params.summary === "string" ? params.summary.trim() : "";

			if (!completedGoal) {
				const rejection = "Goal completion rejected: no active goal.";
				notifyTerminal(ctx.ui, rejection, "warning");

				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
				};
			}
			const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
			if (completedGoal.status === "active" && !runtime.ownsWorkflow(completedGoal)) {
				const rejection = "Goal completion rejected: active Goal no longer owns its workflow.";
				notifyTerminal(ctx.ui, rejection, "warning");
				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
				};
			}
			if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
				const rejection = "Goal completion rejected: current run does not own the active goal.";
				notifyTerminal(ctx.ui, rejection, "warning");
				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
				};
			}
			const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
			if (staleGoalRejection) {
				const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
				notifyTerminal(ctx.ui, rejection, "warning");
				if (completingDuringBudgetWrapUp) {
					runtime.recordGoalUsage(completedGoal, ctx);
					runtime.persistGoal(completedGoal);
					runtime.updateStatus(ctx, completedGoal);
					runtime.clearBudgetWrapUp();
				}

				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}
			if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
				const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
				notifyTerminal(ctx.ui, rejection, "warning");

				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
				};
			}

			const rejectionReason = !summary
				? "summary is empty"
				: summary.length > MAX_COMPLETION_SUMMARY_LENGTH
					? "summary is too long"
					: isContradictoryCompletionSummary(summary)
						? "summary says the goal is not complete"
						: undefined;
			if (rejectionReason) {
				runtime.recordGoalUsage(completedGoal, ctx);
				runtime.persistGoal(completedGoal);
				runtime.updateStatus(ctx, completedGoal);
				const rejection = `Goal completion rejected: ${rejectionReason}.`;
				notifyTerminal(ctx.ui, rejection, "warning");
				if (completingDuringBudgetWrapUp) runtime.clearBudgetWrapUp();

				return {
					content: toolContent(rejection),
					details: completionDetails(goal, requestedGoalId, summary),
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}

			let reviewReport: string | undefined;
			if (runtime.settings.completionReview) {
				const branch = ctx.sessionManager.getBranch();
				const evidence = reviewEvidence(branch, true);
				// Reviewers can inspect actual control results when procedure is part
				// of the objective. Controls still cannot buy a fresh work candidate.
				const candidate = digest(JSON.stringify([completedGoal.text, reviewEvidence(branch)]));
				const previous = completedGoal.review;
				const pause = (reason: string) => {
					runtime.stopActiveGoal(ctx, {
						kind: "agent_interruption",
						expectedGoalId: completedGoal.id,
						status: "paused",
						reason,
					});
					return {
						content: toolContent(reason),
						details: completionDetails(goal, requestedGoalId, summary),
						terminate: true,
					};
				};
				runtime.recordGoalUsage(completedGoal, ctx);
				if (
					completingDuringBudgetWrapUp ||
					(completedGoal.tokenBudget !== undefined &&
						goalBudgetTokens(completedGoal) >= completedGoal.tokenBudget)
				)
					return pause(
						"Goal review unavailable after token budget exhaustion; completion is unverified.",
					);
				if (previous?.status === "running" || previous?.status === "unknown")
					return pause(
						"Previous completion review is unresolved. It will not be replayed, including after resume. Completion remains unverified.",
					);
				if (previous?.candidate === candidate)
					return pause(
						"This evidence candidate was already reviewed. Do new verified work before requesting another review; changing the summary is insufficient.",
					);
				if (
					(previous?.attempts ?? 0) >= REVIEW_LIMITS.attempts ||
					(previous?.reportedTokens ?? 0) >= REVIEW_LIMITS.reportedTokens
				)
					return pause(
						"Goal completion-review allowance exhausted. Resume/edit does not replenish it. Completion remains unverified.",
					);
				const execution = runtime.executionSignal;
				const isCurrent = () =>
					!execution.aborted &&
					runtime.activeGoal?.id === completedGoal.id &&
					runtime.activeGoal.text === completedGoal.text &&
					runtime.agentRunGoalId === completedGoal.id &&
					runtime.ownsWorkflow();
				const signal = AbortSignal.any([
					execution,
					...(_signal ? [_signal] : []),
					AbortSignal.timeout(REVIEW_LIMITS.timeoutMs),
				]);
				completedGoal.review = {
					attempts: (previous?.attempts ?? 0) + 1,
					candidate,
					status: "running",
					reportedTokens: previous?.reportedTokens ?? 0,
				};
				// Persist before dispatch. Crashes, cancellation and late replies cannot
				// turn an ambiguous paid request into a fresh review allowance.
				runtime.persistGoal(completedGoal);
				notifyTerminal(
					ctx.ui,
					"Completion reviewer: selected model, file-only tools, bounded extra usage. USD/credits unknown; this is a second opinion, not a sandbox or end-to-end verifier.",
					"info",
				);
				const outcome = await review({
					ctx,
					objective: completedGoal.text,
					summary,
					evidence,
					signal,
					isCurrent,
					remainingTokens: Math.min(
						REVIEW_LIMITS.reportedTokens - completedGoal.review.reportedTokens,
						completedGoal.tokenBudget === undefined
							? Infinity
							: completedGoal.tokenBudget -
									completedGoal.tokensUsed -
									completedGoal.review.reportedTokens,
					),
				});
				if (!isCurrent()) {
					// Ownership loss forbids approval, but does not erase known usage
					// from this exact persisted attempt if the Goal still exists.
					const current = runtime.activeGoal;
					if (
						current?.id === completedGoal.id &&
						current.review?.status === "running" &&
						current.review.candidate === candidate &&
						current.review.attempts === completedGoal.review.attempts
					) {
						current.review = {
							...current.review,
							status: "unknown",
							reportedTokens: current.review.reportedTokens + outcome.reportedTokens,
						};
						runtime.persistGoal(current);
					}
					return {
						content: toolContent(
							"Completion review became stale or cancelled; no completion was applied.",
						),
						details: {},
						terminate: true,
					};
				}
				const unchanged =
					reviewFilesCurrent(ctx.cwd, outcome.files) &&
					reviewEvidence(ctx.sessionManager.getBranch(), true) === evidence;
				const status = signal.aborted || !unchanged ? "unknown" : outcome.status;
				completedGoal.review = {
					...completedGoal.review,
					status,
					reportedTokens: completedGoal.review.reportedTokens + outcome.reportedTokens,
				};
				runtime.activeGoal!.review = completedGoal.review;
				runtime.persistGoal(runtime.activeGoal!);
				pi.appendEntry("goal-review-result", {
					goalId: completedGoal.id,
					candidate,
					status,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
					calls: outcome.calls,
					reportedTokens: outcome.reportedTokens,
					usageScope: "review-only-partial",
					usd: null,
					credits: null,
				});
				if (status === "unknown")
					return pause(
						`Completion review unresolved: ${unchanged ? outcome.report : "Review evidence changed."} No automatic retry; completion remains unverified.`,
					);
				if (status === "rejected")
					return {
						content: toolContent(
							`Completion reviewer found unverified requirements. Goal remains active; repair using current evidence, then call goal_continue or submit new evidence within the remaining review allowance.\n\n${outcome.report}`,
						),
						details: { review: completedGoal.review },
						terminate: false,
					};
				reviewReport = outcome.report;
				notifyTerminal(
					ctx.ui,
					"Completion reviewer approved the inspected evidence scope (not arbitrary external effects).",
					"info",
				);
			}

			runtime.clearGoalWaitTimer();
			runtime.activeGoal = transitionGoal(runtime.activeGoal ?? completedGoal, "complete");
			runtime.setCompletionSummary(runtime.activeGoal.id, summary);
			runtime.recordGoalUsage(runtime.activeGoal, ctx);
			runtime.persistGoal(runtime.activeGoal);

			ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal));
			runtime.clearCompletedGoal(ctx);
			runtime.showCompletionStatus(ctx);
			notifyTerminal(ctx.ui, `Goal complete: ${goal}`, "info");

			return {
				content: toolContent(
					`Goal complete: ${summary}${reviewReport ? `\n\nCompletion review (inspected evidence only):\n${reviewReport}` : "\n\nCompletion reviewer disabled; result is model-reported."}`,
				),
				details: completionDetails(goal, requestedGoalId, summary),
				terminate: true,
			};
		},
	});

	const goalBlockedTool = defineTool({
		name: GOAL_BLOCKED_TOOL,
		label: "Goal Blocked",
		description:
			"Stop an active /goal only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and the same evidenced external blocker recurred for at least three consecutive Goal turns. Tool visibility alone does not activate Goal mode. Never call for ordinary clarification, uncertainty, incomplete work, or recoverable failures.",
		parameters: Type.Object({
			goal_id: Type.String({
				minLength: 1,
				maxLength: MAX_GOAL_ID_LENGTH,
				description: "The exact goal_id shown in the current active /goal prompt.",
			}),
			reason: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_REASON_LENGTH,
				description: "The specific user or external action required to unblock the goal.",
			}),
			evidence: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
				description: "Concrete evidence from the repeated attempts that proves the impasse.",
			}),
			repeated_turns: Type.Integer({
				minimum: 3,
				description: "Number of separate turns spent trying to resolve this same blocker.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const blockedGoal = runtime.activeGoal;
			const goal = blockedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
			const repeatedTurns =
				typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
			const reject = (rejectionReason: string, terminate = false) => {
				const rejection = `goal_blocked rejected: ${rejectionReason}.`;
				notifyTerminal(ctx.ui, rejection, "warning");
				return {
					content: toolContent(rejection),
					details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
					...(terminate ? { terminate: true as const } : {}),
				};
			};

			if (!blockedGoal) return reject("no active goal");
			if (!runtime.canRecordGoalUsage()) {
				return reject("current run does not own the active goal");
			}
			const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
			if (staleGoalRejection) return reject(staleGoalRejection);
			if (blockedGoal.status !== "active") {
				return reject(`goal is ${blockedGoal.status}, not active`);
			}
			if (!runtime.ownsWorkflow(blockedGoal))
				return reject("active Goal no longer owns its workflow");
			if (!reason) return reject("reason is empty");
			if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
			if (!evidence) return reject("evidence is empty");
			if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
			if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
			if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

			const stoppedGoal = runtime.stopActiveGoal(ctx, {
				kind: "blocker_report",
				expectedGoalId: blockedGoal.id,
				reason,
			});
			if (!stoppedGoal) return reject("active goal changed before blocker transition");
			notifyTerminal(ctx.ui, `Goal blocked: ${truncateNotification(reason)}`, "warning");

			return {
				content: toolContent(`Goal blocked: ${reason}`),
				details: blockerDetails(goal, requestedGoalId, reason, evidence, repeatedTurns),
				terminate: true,
			};
		},
	});

	const goalWaitTool = defineTool({
		name: GOAL_WAIT_TOOL,
		label: "Goal Wait",
		description: `Keep an active /goal quiet only when the latest effective Goal contract explicitly says Goal mode is active, supplies the matching current goal_id, and progress depends on an arranged external wake event or one safety deadline. Tool visibility alone does not activate Goal mode. Call goal_wait alone. Requests below ${MIN_GOAL_WAIT_DELAY_MS}ms are clamped to ${MIN_GOAL_WAIT_DELAY_MS}ms. Never call for ordinary unfinished work.`,
		parameters: Type.Object({
			goal_id: Type.String({
				minLength: 1,
				maxLength: MAX_GOAL_ID_LENGTH,
				description: "The exact goal_id shown in the current active /goal prompt.",
			}),
			reason: Type.String({
				minLength: 1,
				maxLength: MAX_GOAL_WAIT_REASON_LENGTH,
				description: "Why the goal is waiting and which external event should wake it.",
			}),
			resume_after_ms: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_GOAL_WAIT_DELAY_MS,
					description: `Optional safety deadline in milliseconds that requests one continuation if no wake message arrives. Values below ${MIN_GOAL_WAIT_DELAY_MS} are accepted but clamped to ${MIN_GOAL_WAIT_DELAY_MS}.`,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const activeGoal = runtime.activeGoal;
			const goal = activeGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const resumeAfterMs =
				typeof params.resume_after_ms === "number" ? params.resume_after_ms : undefined;
			const reject = (rejectionReason: string) => {
				const rejection = `goal_wait rejected: ${rejectionReason}.`;
				notifyTerminal(ctx.ui, rejection, "warning");
				return {
					content: toolContent(rejection),
					details: waitDetails(goal, requestedGoalId, reason, resumeAfterMs),
				};
			};

			if (!activeGoal) return reject("no active goal");
			if (!runtime.canRecordGoalUsage()) {
				return reject("current run does not own the active goal");
			}
			const staleGoalRejection = goalIdRejectionReason(activeGoal, requestedGoalId);
			if (staleGoalRejection) return reject(staleGoalRejection);
			if (activeGoal.status !== "active") {
				return reject(`goal is ${activeGoal.status}, not active`);
			}
			if (!runtime.ownsWorkflow(activeGoal))
				return reject("active Goal no longer owns its workflow");
			if (activeGoal.waiting) return reject("goal is already waiting");
			if (!reason) return reject("reason is empty");
			if (reason.length > MAX_GOAL_WAIT_REASON_LENGTH) return reject("reason is too long");
			if (
				resumeAfterMs !== undefined &&
				(!Number.isInteger(resumeAfterMs) ||
					resumeAfterMs < 1 ||
					resumeAfterMs > MAX_GOAL_WAIT_DELAY_MS)
			) {
				return reject(`resume_after_ms must be a whole number from 1 to ${MAX_GOAL_WAIT_DELAY_MS}`);
			}

			const { requestedMs, effectiveMs } = resolveGoalWaitDelay(resumeAfterMs);
			const waiting = createGoalWait(reason, resumeAfterMs);
			const waitingGoal = runtime.enterGoalWait(ctx, activeGoal.id, waiting);
			if (!waitingGoal) return reject("active goal changed before waiting transition");
			const clamped = requestedMs !== undefined && effectiveMs !== requestedMs;
			notifyTerminal(ctx.ui, `Goal waiting: ${truncateNotification(reason)}`, "info");
			return {
				content: toolContent(
					clamped
						? `Goal waiting: ${reason}\nRequested resume_after_ms ${requestedMs} was clamped to ${effectiveMs}.`
						: `Goal waiting: ${reason}`,
				),
				details: waitDetails(
					goal,
					requestedGoalId,
					reason,
					effectiveMs,
					waiting.resumeAt,
					clamped ? requestedMs : undefined,
				),
				terminate: true,
			};
		},
	});

	pi.registerTool(goalCompleteTool);
	pi.registerTool(goalBlockedTool);
	pi.registerTool(goalWaitTool);
}

interface GoalCompletionRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

export function goalCompletionMarkdown(result: GoalCompletionRenderResult) {
	const content = result.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
	const completionPrefix = "Goal complete:";
	if (!content.startsWith(completionPrefix)) return content;

	const details = result.details;
	const summary =
		details &&
		typeof details === "object" &&
		"summary" in details &&
		typeof details.summary === "string"
			? details.summary
			: content.slice(completionPrefix.length);
	const safeSummary = safeTerminalText(summary);
	return safeSummary ? `**Goal complete**\n\n${safeSummary}` : "**Goal complete**";
}

export function renderGoalCompletion(result: GoalCompletionRenderResult) {
	return new Markdown(goalCompletionMarkdown(result), 0, 0, getMarkdownTheme());
}

function toolContent(text: string) {
	return [
		{
			type: "text" as const,
			text: truncateHead(safeTerminalText(text), {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			}).content,
		},
	];
}

function completionDetails(goal: string, goalId: string, summary: string): GoalCompleteDetails {
	return {
		goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
		goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
		summary: summary.slice(0, MAX_COMPLETION_SUMMARY_LENGTH),
	};
}

function blockerDetails(
	goal: string,
	goalId: string,
	reason: string,
	evidence: string,
	repeatedTurns: number,
): GoalBlockedDetails {
	return {
		goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
		goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
		reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
		evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
		repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
	};
}

function waitDetails(
	goal: string,
	goalId: string,
	reason: string,
	resumeAfterMs: number | undefined,
	resumeAt?: number,
	requestedResumeAfterMs?: number,
): GoalWaitDetails {
	return {
		goal: goal.slice(0, MAX_GOAL_TEXT_LENGTH),
		goal_id: goalId.slice(0, MAX_GOAL_ID_LENGTH),
		reason: reason.slice(0, MAX_GOAL_WAIT_REASON_LENGTH),
		...(requestedResumeAfterMs === undefined
			? {}
			: { requested_resume_after_ms: requestedResumeAfterMs }),
		...(resumeAfterMs === undefined ? {} : { resume_after_ms: resumeAfterMs }),
		...(resumeAt === undefined ? {} : { resume_at: resumeAt }),
	};
}
