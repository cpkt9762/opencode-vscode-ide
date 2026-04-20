/*---------------------------------------------------------------------------------------------
 *  Copyright (c) pingzi. Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export interface IOpencodeMessage {
	type: string;
	id?: string;
	payload?: unknown;
}

export class MessageBridge extends Disposable {
	private readonly _onMessage = this._register(new Emitter<IOpencodeMessage>());
	readonly onMessage: Event<IOpencodeMessage> = this._onMessage.event;

	private _iframe: HTMLIFrameElement | undefined;

	constructor() {
		super();
		this._register({
			dispose: () => {
				window.removeEventListener('message', this._handleMessage);
			},
		});
		window.addEventListener('message', this._handleMessage);
	}

	setIframe(iframe: HTMLIFrameElement | undefined): void {
		this._iframe = iframe;
	}

	private readonly _handleMessage = (event: MessageEvent): void => {
		if (!this._iframe || event.source !== this._iframe.contentWindow) {
			return;
		}

		const data = event.data as IOpencodeMessage;
		if (data && typeof data.type === 'string') {
			this._onMessage.fire(data);
		}
	};

	send(message: IOpencodeMessage): void {
		this._iframe?.contentWindow?.postMessage(message, '*');
	}
}
