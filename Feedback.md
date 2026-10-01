Yes, both reports were cut off, and the same way each time. Here's what happened and what I'd change.

**What happened**
- **Both lost their beginnings.** The scout crew report began partway through section 9, so sections 1–8 never arrived. The single scout report began partway through section 4, so sections 1–3 were lost.
- **The size cap is small.** What arrived was about 4–5k characters each time. Even the 1,400-word cap I gave the second scout was too large for it, which suggests the outcome summary has a fixed limit around that size.
- **It keeps the tail.** The limit drops the start of the report and keeps the end. That's the worst part to lose, because reports put the most important findings first and end with limitations and risk lists.
- **No way to get the full text.** `sane_worker_status` returned the same cut-off text. I searched `~/.claude/projects`, `~/.local/share` and `~/Library/Application Support` for a phrase from the report and found nothing. If the full worker transcripts are stored somewhere else (the App's data directory, for example), I didn't find it.
- **The cost.** The crew run took about 17 minutes, and most of its detailed findings were lost. I filled the gaps with a second run plus my own targeted searches. The SDD rests on checked evidence, but the process paid for the same answers twice.

**Can a scout write a document instead?**

Not as designed. The scout and scout-crew workers are defined as read-only: they return findings inline to whoever started them and don't change files. The research worker is the one that writes its findings to a file, and `sane research register` adds that file to the workstream. For a question this broad, starting a research worker would have avoided the problem, at the cost of more ceremony.

**Suggested fixes, most useful first**
1. **Let scouts write a report file.** An approved spot such as a scratch folder under the workstream, with the summary pointing to it.
2. **Keep the beginning, not the end.** When the summary is over the limit, keep the head, or the head plus tail with a marker showing where text was cut.
3. **Tell workers the limit.** Put the exact cap in the worker instructions, so they can size their reports.
4. **Make full output retrievable.** Have `sane_worker_status` return the complete output, or give the path to the worker's transcript.
5. **On my side:** until that's fixed, I'll split big audits into several small scouts, each with one or two questions, so every answer fits under the cap.