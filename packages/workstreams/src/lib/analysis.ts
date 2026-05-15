import { existsSync } from "fs" // Use node:fs or fs? using fs to match existing file, but typically node:fs is better. existing file used "fs".
import { join, dirname } from "path"
import type { StreamDocument, BatchDefinition, ThreadDefinition } from "./types.ts"

export interface OpenQuestion {
    line: number
    question: string
    stage?: number
}

/**
 * Information about a file shared across parallel threads
 */
export interface SharedFileWarning {
    file: string
    stageId: number
    stageName: string
    batchId: number
    batchName: string
    threads: { id: number; name: string }[]
}

/**
 * Find open questions (unchecked checkboxes) with line numbers and context
 */
export function findOpenQuestions(content: string): OpenQuestion[] {
    const lines = content.split("\n")
    const questions: OpenQuestion[] = []
    let currentStage: number | undefined

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!

        // Track current stage
        const stageMatch = line.match(/^###\s+Stage\s+(\d+):/i)
        if (stageMatch) {
            currentStage = parseInt(stageMatch[1]!, 10)
        }

        // Find unchecked items
        const checkboxMatch = line.match(/\[\s\]\s*(.*)$/)
        if (checkboxMatch) {
            questions.push({
                line: i + 1,
                question: checkboxMatch[1]!.trim(),
                stage: currentStage
            })
        }
    }

    return questions
}

/**
 * Extract file paths referenced in Constitution "Inputs:" sections
 */
export function extractInputFileReferences(content: string): string[] {
    const files: string[] = []
    const lines = content.split("\n")
    let inInputsSection = false

    for (const line of lines) {
        // Detect Inputs section start
        if (/\*\*Inputs:\*\*/i.test(line) || /^Inputs:/i.test(line.trim())) {
            inInputsSection = true
            continue
        }

        // End of Inputs section (new bold header or H4/H5)
        if (inInputsSection && (/^\*\*[^*]+\*\*/.test(line.trim()) || /^#{4,5}\s/.test(line))) {
            inInputsSection = false
        }

        // Extract file paths from list items in Inputs section
        if (inInputsSection && line.trim().startsWith("-")) {
            // Look for file path patterns
            const filePatterns = [
                /`([^`]+\.[a-z]+)`/gi, // `file.ext`
                /\[([^\]]+)\]\(file:\/\/([^)]+)\)/gi, // [name](file://path)
                /(?:^|\s)([\w./-]+\.[a-z]{1,4})(?:\s|$)/gi // plain file.ext
            ]

            for (const pattern of filePatterns) {
                let match
                while ((match = pattern.exec(line)) !== null) {
                    const file = match[2] || match[1]
                    if (file && !file.includes("*")) {
                        files.push(file)
                    }
                }
            }
        }
    }

    return [...new Set(files)] // dedupe
}

/**
 * Check which referenced files don't exist
 */
export function findMissingInputFiles(repoRoot: string, planMdPath: string, files: string[]): string[] {
    const planDir = dirname(planMdPath)
    const missing: string[] = []

    for (const file of files) {
        // Try multiple locations: relative to plan, relative to repo, absolute
        const candidates = [
            join(planDir, file),
            join(repoRoot, file),
            file
        ]

        const exists = candidates.some(p => existsSync(p))
        if (!exists) {
            missing.push(file)
        }
    }

    return missing
}

/**
 * Extract file paths from thread content (summary + details)
 * Looks for common file reference patterns:
 * - `file.ext` (backtick-quoted)
 * - [name](file://path)
 * - Common file paths (word/word.ext patterns)
 */
export function extractFilesFromThread(thread: ThreadDefinition): string[] {
    const files: string[] = []
    const content = `${thread.summary}\n${thread.details}`

    const filePatterns = [
        /`([^`]+\.[a-z]{1,6})`/gi, // `file.ext`
        /\[([^\]]+)\]\(file:\/\/([^)]+)\)/gi, // [name](file://path)
        /(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.[a-z]{1,6})(?:\s|$|[,;:)])/gim // path/to/file.ext
    ]

    for (const pattern of filePatterns) {
        let match
        while ((match = pattern.exec(content)) !== null) {
            const file = match[2] || match[1]
            if (file && !file.includes("*") && !file.startsWith("http")) {
                files.push(file)
            }
        }
    }

    return [...new Set(files)] // dedupe
}

/**
 * Find files that are referenced by multiple threads within the same batch.
 * Since threads in the same batch run in parallel, sharing files between them
 * can cause race conditions or conflicts.
 * 
 * @param doc - Parsed StreamDocument from PLAN.md
 * @returns Array of warnings for shared files
 */
export function findSharedFilesInParallelThreads(doc: StreamDocument): SharedFileWarning[] {
    const warnings: SharedFileWarning[] = []

    for (const stage of doc.stages) {
        for (const batch of stage.batches) {
            // Skip batches with only one thread (no parallelism)
            if (batch.threads.length <= 1) {
                continue
            }

            // Map file -> threads that reference it
            const fileToThreads = new Map<string, { id: number; name: string }[]>()

            for (const thread of batch.threads) {
                const files = extractFilesFromThread(thread)
                for (const file of files) {
                    const normalizedFile = file.toLowerCase() // Case-insensitive comparison
                    if (!fileToThreads.has(normalizedFile)) {
                        fileToThreads.set(normalizedFile, [])
                    }
                    fileToThreads.get(normalizedFile)!.push({
                        id: thread.id,
                        name: thread.name
                    })
                }
            }

            // Find files referenced by more than one thread
            for (const [file, threads] of fileToThreads) {
                if (threads.length > 1) {
                    warnings.push({
                        file,
                        stageId: stage.id,
                        stageName: stage.name,
                        batchId: batch.id,
                        batchName: batch.name,
                        threads
                    })
                }
            }
        }
    }

    return warnings
}

/**
 * Format shared file warnings as human-readable strings
 */
export function formatSharedFileWarnings(warnings: SharedFileWarning[]): string[] {
    return warnings.map(w => {
        const threadList = w.threads.map(t => `Thread ${t.id} (${t.name})`).join(", ")
        return `File "${w.file}" is shared across parallel threads, please reconsider planning. ` +
            `Stage ${w.stageId} (${w.stageName}), Batch ${w.batchId} (${w.batchName}): ${threadList}`
    })
}

/**
 * Extract file paths from text content (task descriptions, etc.)
 * Looks for common file reference patterns
 */
export function extractFilesFromText(text: string): string[] {
    const files: string[] = []

    const filePatterns = [
        /`([^`]+\.[a-z]{1,6})`/gi, // `file.ext`
        /\[([^\]]+)\]\(file:\/\/([^)]+)\)/gi, // [name](file://path)
        /(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.[a-z]{1,6})(?:\s|$|[,;:)])/gim // path/to/file.ext
    ]

    for (const pattern of filePatterns) {
        let match
        while ((match = pattern.exec(text)) !== null) {
            const file = match[2] || match[1]
            if (file && !file.includes("*") && !file.startsWith("http")) {
                files.push(file)
            }
        }
    }

    return [...new Set(files)] // dedupe
}

/**
 * Find files that are referenced by multiple threads within the same batch.
 * Parses the stream document structure to detect parallel thread file conflicts.
 * 
 * @param content - Raw stream planning content
 * @returns Array of warnings for shared files
 */
export function findSharedFilesInPlan(content: string): SharedFileWarning[] {
    const warnings: SharedFileWarning[] = []
    const lines = content.split("\n")

    // Parse structure to extract batches and threads
    // Stream planning format:
    // ## Stage NN: StageName
    // ### Batch NN: BatchName
    // #### Thread NN: ThreadName @agent:...
    // - [ ] Description
    
    interface ParsedThread {
        id: number
        name: string
        items: string[]
    }

    interface ParsedBatch {
        id: number
        name: string
        threads: ParsedThread[]
    }

    interface ParsedStage {
        id: number
        name: string
        batches: ParsedBatch[]
    }

    const stages: ParsedStage[] = []
    let currentStage: ParsedStage | null = null
    let currentBatch: ParsedBatch | null = null
    let currentThread: ParsedThread | null = null

    for (const line of lines) {
        // Match Stage heading: ## Stage NN: Name
        const stageMatch = line.match(/^##\s+Stage\s+(\d+):\s*(.*)$/i)
        if (stageMatch) {
            if (currentStage) {
                if (currentBatch) {
                    if (currentThread) {
                        currentBatch.threads.push(currentThread)
                    }
                    currentStage.batches.push(currentBatch)
                }
                stages.push(currentStage)
            }
            currentStage = {
                id: parseInt(stageMatch[1]!, 10),
                name: stageMatch[2]!.trim(),
                batches: []
            }
            currentBatch = null
            currentThread = null
            continue
        }

        // Match Batch heading: ### Batch NN: Name
        const batchMatch = line.match(/^###\s+Batch\s+(\d+):\s*(.*)$/i)
        if (batchMatch && currentStage) {
            if (currentBatch) {
                if (currentThread) {
                    currentBatch.threads.push(currentThread)
                }
                currentStage.batches.push(currentBatch)
            }
            currentBatch = {
                id: parseInt(batchMatch[1]!, 10),
                name: batchMatch[2]!.trim(),
                threads: []
            }
            currentThread = null
            continue
        }

        // Match Thread heading: #### Thread NN: Name [@agent:...]
        const threadMatch = line.match(/^####\s+Thread\s+(\d+):\s*([^@]*)(?:@agent:.*)?$/i)
        if (threadMatch && currentBatch) {
            if (currentThread) {
                currentBatch.threads.push(currentThread)
            }
            currentThread = {
                id: parseInt(threadMatch[1]!, 10),
                name: threadMatch[2]!.trim(),
                items: []
            }
            continue
        }

        // Match checklist lines.
        const itemMatch = line.match(/^\s*-\s*\[[^\]]*\]\s*(.*)/i)
        if (itemMatch && currentThread) {
            const itemDescription = itemMatch[1]!.trim()
            if (itemDescription) {
                currentThread.items.push(itemDescription)
            }
            continue
        }
    }

    // Save last items
    if (currentStage) {
        if (currentBatch) {
            if (currentThread) {
                currentBatch.threads.push(currentThread)
            }
            currentStage.batches.push(currentBatch)
        }
        stages.push(currentStage)
    }

    // Now check for shared files in parallel threads (same batch)
    for (const stage of stages) {
        for (const batch of stage.batches) {
            // Skip batches with only one thread
            if (batch.threads.length <= 1) {
                continue
            }

            // Map file -> threads that reference it
            const fileToThreads = new Map<string, { id: number; name: string }[]>()

            for (const thread of batch.threads) {
                // Combine all item descriptions for this thread
                const allItemText = thread.items.join("\n")
                const files = extractFilesFromText(allItemText)

                for (const file of files) {
                    const normalizedFile = file.toLowerCase()
                    if (!fileToThreads.has(normalizedFile)) {
                        fileToThreads.set(normalizedFile, [])
                    }
                    fileToThreads.get(normalizedFile)!.push({
                        id: thread.id,
                        name: thread.name
                    })
                }
            }

            // Find files referenced by more than one thread
            for (const [file, threads] of fileToThreads) {
                if (threads.length > 1) {
                    warnings.push({
                        file,
                        stageId: stage.id,
                        stageName: stage.name,
                        batchId: batch.id,
                        batchName: batch.name,
                        threads
                    })
                }
            }
        }
    }

    return warnings
}
