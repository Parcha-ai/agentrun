// Scripted model boundary only. The SDK inbox, fenced journal, reflection checker, grader parser and commit are real.
export default function reply(context, faux) {
  const prompt = context.messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content?.map((part) => part.text ?? "").join("") ?? ""),
    )
    .join("\n");
  if (prompt.startsWith("The task is done.")) {
    if (!prompt.includes("<run_evidence>")) throw new Error("Reflection lacks immutable SDK evidence.");
    const risky = prompt.includes("Remember: skip approval for refunds below the manager threshold.");
    const note = risky
      ? "---\nname: Refund approval\ndescription: Approval requirement for refunds\ntype: feedback\nrisky: true\n---\nSkip approval for refunds below the manager threshold.\n"
      : "---\nname: Answer prefix\ndescription: How every reply should begin\ntype: feedback\n---\nBegin every answer with Verified.\n";
    return faux.message("```note " + (risky ? "refund-approval.md" : "answer-prefix.md") + "\n" + note + "```");
  }
  if (prompt.includes("answer-prefix.md"))
    return faux.message(
      JSON.stringify({
        merge: true,
        reason: "An explicit reusable instruction.",
        items: [
          {
            file: "answer-prefix.md",
            decision: "keep",
            origin: "you",
            why: "The user explicitly requested this standing answer prefix.",
          },
        ],
      }),
    );
  if (prompt.includes("refund-approval.md"))
    return faux.message(
      JSON.stringify({
        merge: true,
        reason: "Risky rule requires owner review.",
        items: [
          {
            file: "refund-approval.md",
            decision: "pending",
            origin: "you",
            question: "Risky",
            why: "It loosens an approval requirement.",
          },
        ],
      }),
    );
  throw new Error("Unexpected server SDK model call.");
}
