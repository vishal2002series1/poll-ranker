// ── Scoring & Speed Algorithm (cumulative session model) ──
//
// Pure, dependency-free logic so it can run in either process and be reasoned
// about in isolation.
//
// A SESSION contains many QUESTIONS. For each question a "vote" is the first
// valid A–E answer a unique YouTube channel submitted during that question's
// active window (the scraper de-duplicates, so each channelId appears once per
// question). Students accumulate POINTS across questions; the session-wide
// leaderboard ("Top Performers") ranks by cumulative points.
//
// IMPORTANT — about timing accuracy:
//   `arrivalTs` is when the message was *observed on the teacher's machine*,
//   not the instant the student pressed Enter. YouTube Live chat is delivered
//   in batches and the broadcast is delayed, so elapsed time is a *relative
//   ordering* normalised by the configurable buffer offset — not true human
//   reaction time.

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E'];

// Speed-weighted points (Kahoot-style). A correct answer at t=0 scores
// MAX_POINTS; one arriving at the buzzer scores MIN_POINTS; wrong answers
// score 0. Linear between the two so faster always beats slower.
const MAX_POINTS = 1000;
const MIN_POINTS = 500;

/**
 * Points for a single answer on one question.
 * @param {number} elapsedMs   - response time relative to poll start (offset-adjusted)
 * @param {number} timeLimitMs - question duration in ms
 * @param {boolean} isCorrect
 */
function pointsFor(elapsedMs, timeLimitMs, isCorrect) {
  if (!isCorrect) return 0;
  if (!timeLimitMs || timeLimitMs <= 0) return MAX_POINTS;
  const frac = Math.min(1, Math.max(0, elapsedMs / timeLimitMs));
  return Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * frac);
}

/**
 * Score the raw votes captured for ONE question.
 *
 * @param {Array<{channelId, handle, answer, arrivalTs}>} votes
 * @param {Object} opts
 * @param {number} opts.pollStartTs
 * @param {string|null} opts.correctAnswer
 * @param {number} [opts.bufferOffsetMs=0]
 * @param {number} [opts.timeLimitMs=0]
 * @returns {Array} scored rows (one per unique voter)
 */
function scoreQuestion(votes, { pollStartTs, correctAnswer = null, bufferOffsetMs = 0, timeLimitMs = 0 } = {}) {
  return votes.map((v) => {
    const elapsedMs = Math.max(0, v.arrivalTs - pollStartTs - bufferOffsetMs);
    const isCorrect = correctAnswer != null && v.answer === correctAnswer;
    return {
      channelId: v.channelId,
      handle: v.handle,
      answer: v.answer,
      arrivalTs: v.arrivalTs,
      elapsedMs,
      isCorrect,
      points: pointsFor(elapsedMs, timeLimitMs, isCorrect),
    };
  });
}

/**
 * Vote distribution for ONE question across the options in play (4 or 5).
 */
function tally(scoredVotes, optionCount, correctAnswer = null) {
  const letters = OPTION_LETTERS.slice(0, optionCount);
  const counts = Object.fromEntries(letters.map((l) => [l, 0]));

  let totalVotes = 0;
  for (const v of scoredVotes) {
    if (counts[v.answer] !== undefined) {
      counts[v.answer]++;
      totalVotes++;
    }
  }

  const breakdown = letters.map((letter) => {
    const count = counts[letter];
    const pct = totalVotes > 0 ? (count / totalVotes) * 100 : 0;
    return {
      letter,
      count,
      pct: Math.round(pct * 10) / 10,
      isCorrect: correctAnswer != null && letter === correctAnswer,
    };
  });

  const correctVotes = correctAnswer != null ? counts[correctAnswer] || 0 : 0;
  const accuracy =
    correctAnswer != null && totalVotes > 0
      ? Math.round((correctVotes / totalVotes) * 1000) / 10
      : 0;

  return { breakdown, totalVotes, correctVotes, accuracy };
}

/**
 * Per-question ranking: fastest correct first (correctness, then speed).
 */
function rankQuestion(scoredVotes) {
  return [...scoredVotes].sort((a, b) => {
    if (a.isCorrect !== b.isCorrect) return a.isCorrect ? -1 : 1;
    return a.elapsedMs - b.elapsedMs;
  });
}

/**
 * Fold many scored questions into a cumulative per-voter scoreboard.
 * Each entry tracks total points, correct count, cumulative time, and the
 * answer/time from the MOST RECENT question (what the Top Performers columns
 * display alongside the cumulative rank).
 *
 * @param {Array<Array>} questions - array of scoreQuestion() results, in order
 * @returns {Array} cumulative entries
 */
function accumulate(questions) {
  const byVoter = new Map();

  questions.forEach((scored) => {
    scored.forEach((v) => {
      let e = byVoter.get(v.channelId);
      if (!e) {
        e = {
          channelId: v.channelId,
          handle: v.handle,
          totalPoints: 0,
          correctCount: 0,
          answeredCount: 0,
          totalElapsedMs: 0,
        };
        byVoter.set(v.channelId, e);
      }
      e.handle = v.handle; // keep latest handle
      e.totalPoints += v.points;
      e.correctCount += v.isCorrect ? 1 : 0;
      e.answeredCount += 1;
      e.totalElapsedMs += v.elapsedMs;
      // Latest-question snapshot for the display columns.
      e.lastAnswer = v.answer;
      e.lastElapsedMs = v.elapsedMs;
      e.lastIsCorrect = v.isCorrect;
    });
  });

  return [...byVoter.values()];
}

/**
 * Rank cumulative entries: total points desc, then more-correct, then faster
 * cumulative time. This is the tie-breaker chain for the Top Performers board.
 */
function rankCumulative(entries) {
  return [...entries].sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
    return a.totalElapsedMs - b.totalElapsedMs;
  });
}

function topN(entries, n = 10) {
  return rankCumulative(entries).slice(0, n);
}

/**
 * Format an elapsed-ms value as SS.ss (hundredths), e.g. 27460 -> "27.46s".
 */
function formatElapsed(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * CSV of the cumulative session for "Export to CSV".
 */
function buildCsv(cumulativeEntries, meta = {}) {
  const ranked = rankCumulative(cumulativeEntries);
  const esc = (val) => {
    const s = String(val ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [];
  if (meta.streamUrl) lines.push(`# Stream,${esc(meta.streamUrl)}`);
  if (meta.totalQuestions != null) lines.push(`# Total Questions,${meta.totalQuestions}`);
  if (meta.exportedAt) lines.push(`# Exported,${esc(meta.exportedAt)}`);
  lines.push('');

  lines.push(
    ['Rank', 'Handle', 'Channel ID', 'Total Points', 'Correct', 'Answered', 'Cumulative Time (ms)', 'Last Answer'].join(',')
  );
  ranked.forEach((e, i) => {
    lines.push(
      [
        i + 1,
        esc(e.handle),
        esc(e.channelId),
        e.totalPoints,
        e.correctCount,
        e.answeredCount,
        e.totalElapsedMs,
        e.lastAnswer || '',
      ].join(',')
    );
  });

  return lines.join('\n');
}

module.exports = {
  OPTION_LETTERS,
  MAX_POINTS,
  MIN_POINTS,
  pointsFor,
  scoreQuestion,
  tally,
  rankQuestion,
  accumulate,
  rankCumulative,
  topN,
  formatElapsed,
  buildCsv,
};
