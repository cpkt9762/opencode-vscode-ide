/*---------------------------------------------------------------------------------------------
 *  Copyright (c) user. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

// https://github.com/user/opencode-ide/issues/1
// Proposed API surface v0.1

/// <reference path="./vscode.d.ts" />

declare module 'vscode' {

	export namespace opencodeEditor {

		export interface WidgetContent {
			html: string;
			style?: { readonly [cssProperty: string]: string };
			commands?: ReadonlyArray<{
				selector: string;
				event: 'click' | 'keydown';
				command: string;
				args?: unknown[];
			}>;
		}

		export interface OpencodeViewZone {
			readonly id: string;
			readonly afterLineNumber: number;
			heightInLines: number;
			setContent(content: WidgetContent): Thenable<void>;
			dispose(): void;
		}

		export function createViewZone(
			editor: TextEditor,
			options: {
				afterLineNumber: number;
				heightInLines: number;
				content: WidgetContent;
			}
		): Thenable<OpencodeViewZone>;

		export interface OpencodeOverlayWidget {
			readonly id: string;
			setPosition(pos: { preference: 'TOP_RIGHT_CORNER' | 'BOTTOM_RIGHT_CORNER' | null }): Thenable<void>;
			setContent(content: WidgetContent): Thenable<void>;
			dispose(): void;
		}

		export function createOverlayWidget(
			editor: TextEditor,
			options: {
				id: string;
				content: WidgetContent;
				position: { preference: 'TOP_RIGHT_CORNER' | 'BOTTOM_RIGHT_CORNER' };
			}
		): Thenable<OpencodeOverlayWidget>;

		export interface OpencodeContentWidget {
			readonly id: string;
			setPosition(line: number, column: number): Thenable<void>;
			setContent(content: WidgetContent): Thenable<void>;
			dispose(): void;
		}

		export function createContentWidget(
			editor: TextEditor,
			options: {
				id: string;
				content: WidgetContent;
				position: { line: number; column: number };
			}
		): Thenable<OpencodeContentWidget>;
	}
}
