"use client";

import { useState } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import { downloadBlob } from "@/utils/browser";
import { getExportFileExtension, getExportMimeType } from "@/lib/export";
import { resolveCardVid } from "@/lib/export/card-target";
import {
	advanceCardStageToReview,
	uploadRenderToCard,
} from "@/lib/export/upload-to-card";
import { Check, Copy, Download, ExternalLink, RotateCcw } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
} from "@/lib/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/hooks/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/lib/export/defaults";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
						<span className="z-50 text-[0.875rem]">Export</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
			</PopoverTrigger>
			{hasProject && isExportPopoverOpen && (
				// Mount fresh on open so the post-export state machine resets.
				<ExportPopover onOpenChange={setIsExportPopoverOpen} />
			)}
		</Popover>
	);
}

// State of the export popover AFTER the render finishes. While the render itself
// runs we lean on the editor's exportState (isExporting/progress); these phases
// drive what happens to the finished blob — upload it to the card's Publish slot,
// fall back to a plain download, or recover from an upload failure.
type PostExport =
	| { kind: "config" }
	| { kind: "rendering" }
	| { kind: "uploading"; pct: number; label: string }
	| { kind: "done"; blob: Blob; filename: string; vid: string }
	| { kind: "no-card"; blob: Blob; filename: string }
	| {
			kind: "error";
			message: string;
			blob: Blob;
			filename: string;
			contentType: string;
			vid: string;
	  };

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, result: exportResult } = exportState;
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [post, setPost] = useState<PostExport>({ kind: "config" });

	// Upload the finished render to the card's Publish video slot (presign → PUT →
	// finalize), then best-effort advance the card to Review. Shared by the
	// initial export and the retry button.
	const runUpload = async ({
		vid,
		blob,
		filename,
		contentType,
	}: {
		vid: string;
		blob: Blob;
		filename: string;
		contentType: string;
	}) => {
		setPost({ kind: "uploading", pct: 0, label: "Preparing upload…" });
		try {
			await uploadRenderToCard({
				vid,
				file: blob,
				filename,
				contentType,
				onProgress: (p) => {
					if (p.phase === "uploading") {
						setPost({
							kind: "uploading",
							pct: p.pct,
							label: `Uploading to Publish… ${p.pct}%`,
						});
					} else if (p.phase === "finalizing") {
						setPost({ kind: "uploading", pct: 100, label: "Finishing…" });
					}
				},
			});
			setPost({ kind: "done", blob, filename, vid });
			// Move the card forward to Review — best-effort, never blocks the result.
			advanceCardStageToReview({ vid }).catch(() => {});
		} catch (e) {
			setPost({
				kind: "error",
				message: (e as Error).message || "Upload failed",
				blob,
				filename,
				contentType,
				vid,
			});
		}
	};

	// One render, two destinations: "publish" uploads the result to the card's
	// Publish slot; "download" saves it to disk (the old Export behavior).
	const handleRender = async (mode: "publish" | "download") => {
		if (!activeProject) return;

		setPost({ kind: "rendering" });
		const result = await editor.project.export({
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
			},
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			setPost({ kind: "config" });
			return;
		}

		if (!result.success || !result.blob) {
			// Render-stage failure — surface the editor's ExportError (reads
			// exportState.result). Reset post so the body falls through to it.
			setPost({ kind: "config" });
			return;
		}

		const blob = result.blob;
		const filename = `${activeProject.metadata.name}${getExportFileExtension({ format })}`;
		const contentType = getExportMimeType({ format });

		// "Download" — old behavior: save to disk, no card upload.
		if (mode === "download") {
			downloadBlob({ blob, filename });
			editor.project.clearExportState();
			onOpenChange(false);
			return;
		}

		// "Export to Publish" — upload to the card's Publish slot. Leave
		// exportState as-is (progress holds ~100%) so the bar doesn't flash to 0%
		// before the upload view mounts; the close handler clears it.
		const vid =
			typeof window !== "undefined"
				? resolveCardVid({
						projectId: activeProject.metadata.id,
						storage: window.localStorage,
					})
				: null;

		if (!vid) {
			// Not opened from a card (rare) — nowhere to publish, offer a download.
			setPost({ kind: "no-card", blob, filename });
			return;
		}

		await runUpload({ vid, blob, filename, contentType });
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	// True from the moment Export is clicked until the render finishes — covers
	// the brief gap after export() resolves but before the upload view mounts, so
	// the progress bar doesn't flicker to the config form.
	const rendering = isExporting || post.kind === "rendering";

	// Post-export takeover views (upload / done / no-card / upload-error).
	if (post.kind === "uploading") {
		return (
			<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
				<div className="flex items-center justify-between p-3 border-b">
					<h3 className="font-medium text-sm">Sending to Publish</h3>
				</div>
				<div className="space-y-4 p-3">
					<div className="flex flex-col gap-2">
						<div className="flex items-center justify-between">
							<p className="text-muted-foreground text-sm">{post.label}</p>
							<p className="text-muted-foreground text-sm">{post.pct}%</p>
						</div>
						<Progress value={post.pct} className="w-full" />
					</div>
				</div>
			</PopoverContent>
		);
	}

	if (post.kind === "done") {
		return (
			<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
				<div className="space-y-3 p-3">
					<div className="flex items-center gap-2">
						<Check className="text-constructive size-4" />
						<p className="text-sm font-medium">Sent to Publish</p>
					</div>
					<p className="text-muted-foreground text-xs">
						Your render is attached to this card. Open it in CreatorGrowth to
						watch it and cross-post.
					</p>
					<Button
						className="w-full gap-2"
						onClick={() =>
							window.open(
								`${window.location.origin}/?card=${post.vid}&view=publish`,
								"_blank",
								"noopener",
							)
						}
					>
						<ExternalLink className="size-4" />
						Open in CreatorGrowth
					</Button>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							className="h-8 flex-1 text-xs"
							onClick={() =>
								downloadBlob({ blob: post.blob, filename: post.filename })
							}
						>
							<Download className="size-3.5" />
							Download a copy
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="h-8 flex-1 text-xs"
							onClick={() => onOpenChange(false)}
						>
							Done
						</Button>
					</div>
				</div>
			</PopoverContent>
		);
	}

	if (post.kind === "no-card") {
		return (
			<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
				<div className="space-y-3 p-3">
					<p className="text-sm font-medium">Export ready</p>
					<p className="text-muted-foreground text-xs">
						This project isn&apos;t linked to a creatorgrowth card, so
						there&apos;s no Publish slot to send it to. Download the file
						instead.
					</p>
					<Button
						variant="outline"
						size="sm"
						className="h-8 w-full text-xs"
						onClick={() => {
							downloadBlob({ blob: post.blob, filename: post.filename });
							onOpenChange(false);
						}}
					>
						<Download className="size-3.5" />
						Download
					</Button>
				</div>
			</PopoverContent>
		);
	}

	if (post.kind === "error") {
		const { blob, filename, contentType, vid } = post;
		return (
			<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
				<div className="space-y-4 p-3">
					<div className="flex flex-col gap-1.5">
						<p className="text-destructive text-sm font-medium">
							Upload failed
						</p>
						<p className="text-muted-foreground text-xs">{post.message}</p>
					</div>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							className="h-8 flex-1 text-xs"
							onClick={() => downloadBlob({ blob, filename })}
						>
							<Download className="size-3.5" />
							Download
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="h-8 flex-1 text-xs"
							onClick={() => runUpload({ vid, blob, filename, contentType })}
						>
							<RotateCcw className="size-3.5" />
							Retry
						</Button>
					</div>
				</div>
			</PopoverContent>
		);
	}

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={() => handleRender("publish")}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{rendering ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!rendering && (
							<>
								<div className="flex flex-col">
									<Section
										collapsible
										defaultOpen={false}
										showTopBorder={false}
									>
										<SectionHeader>
											<SectionTitle>Format</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 (H.264) - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM (VP9) - Smaller file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Quality</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={quality}
												onValueChange={(value) => {
													if (isExportQuality(value)) {
														setQuality(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="low" id="low" />
													<Label htmlFor="low">Low - Smallest file size</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="medium" id="medium" />
													<Label htmlFor="medium">Medium - Balanced</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="high" id="high" />
													<Label htmlFor="high">High - Recommended</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="very_high" id="very_high" />
													<Label htmlFor="very_high">
														Very high - Largest file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={shouldIncludeAudio}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													Include audio in export
												</Label>
											</div>
										</SectionContent>
									</Section>
								</div>

								<div className="flex flex-col gap-2 p-3 pt-0">
									<Button
										onClick={() => handleRender("publish")}
										className="w-full gap-2"
									>
										<HugeiconsIcon
											icon={TransitionTopIcon}
											className="size-4"
										/>
										Export to Publish
									</Button>
									<Button
										variant="outline"
										onClick={() => handleRender("download")}
										className="w-full gap-2"
									>
										<Download className="size-4" />
										Download
									</Button>
								</div>
							</>
						)}

						{rendering && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
								>
									Cancel
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
		</div>
	);
}
