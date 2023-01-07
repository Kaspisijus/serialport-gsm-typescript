import * as pdu from '@killerjulian/node-pdu';
import { SerialPort } from 'serialport';
import { CommandResponse, ModemConstructorOptions, PduSms, SendSmsFailed, SendSmsSuccess, SerialPortOptions } from './types';
import { Command } from './utils/Command';
import { CommandHandler } from './utils/CommandHandler';
import { Events } from './utils/Events';
import { CmdStack, ModemMode, ModemOptions, resultCode, simplifyResponse } from './utils/utils';

export class Modem {
	// options
	private readonly pinCode: string | null;
	private readonly options: ModemOptions;

	// system
	private readonly port: SerialPort;
	private readonly events = new Events();
	private readonly cmdHandler: CommandHandler;

	constructor(targetDevice: string, options: ModemConstructorOptions = {}) {
		this.pinCode = options.pin || null;

		this.options = {
			deleteSmsOnReceive: options.deleteSmsOnReceive !== undefined ? options.deleteSmsOnReceive : false,
			enableConcatenation: options.enableConcatenation !== undefined ? options.enableConcatenation : true,
			customInitCommand: options.customInitCommand !== undefined ? options.customInitCommand : null,
			autoInitOnOpen: options.autoInitOnOpen !== undefined ? options.autoInitOnOpen : true,
			cnmiCommand: options.cnmiCommand !== undefined ? options.cnmiCommand : 'AT+CNMI=2,1,0,2,1'
		};

		const serialPortOptions: SerialPortOptions = Object.assign(
			// defaults
			{
				baudRate: 9600,
				dataBits: 8,
				stopBits: 1,
				highWaterMark: 16384,
				parity: 'none',
				rtscts: false,
				xon: false,
				xoff: false
			},
			// options
			options.serialPortOptions,
			// overide options
			{
				path: targetDevice,
				autoOpen: false
			}
		);

		this.port = new SerialPort(serialPortOptions);
		this.cmdHandler = new CommandHandler(this, this.port, this.events);

		this.on('onNewSms', (id) => this.options.deleteSmsOnReceive && this.deleteSms(id).catch());
	}

	/*
	 * getter
	 */

	get targetDevice() {
		return this.port.path;
	}

	get isOpen() {
		return this.port.isOpen;
	}

	get queueLength() {
		return this.cmdHandler.prioQueue.length + this.cmdHandler.queue.length;
	}

	/*
	 * private functions
	 */

	private async checkPinRequired(prio = false) {
		const response = await simplifyResponse(this.executeATCommand('AT+CPIN?', prio));

		if (!response.toUpperCase().startsWith('+CPIN:') || response.toUpperCase().includes('ERROR')) {
			throw new Error(`serialport-gsm/${this.port.path}: Failed to detect if the modem requires a pin!`);
		}

		return !response.toUpperCase().includes('READY');
	}

	private async enableClip(prio = false) {
		const response = await simplifyResponse(this.executeATCommand('AT+CLIP=1', prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Modem clip can not be activated!`);
		}
	}

	private async enableCNMI(prio = false) {
		const response = await simplifyResponse(this.executeATCommand(this.options.cnmiCommand, prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Failed to execute the cnmiCommand!`);
		}
	}

	private async setEchoMode(enable: boolean, prio = false) {
		const response = await simplifyResponse(this.executeATCommand(enable ? 'ATE1' : 'ATE0', prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Modem echo can not be activated!`);
		}
	}

	private async providePin(prio = false) {
		const response = await simplifyResponse(this.executeATCommand(`AT+CPIN=${this.pinCode}`, prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Modem could not be unlocked with pin!`);
		}
	}

	private async resetModem(prio = false) {
		const response = await simplifyResponse(this.executeATCommand('ATZ', prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Modem failed to reset!`);
		}
	}

	private async setMode(mode: ModemMode, prio = false) {
		const response = await simplifyResponse(this.executeATCommand(`AT+CMGF=${mode === 'PDU' ? 0 : 1}`, prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: The setting of the mode failed!`);
		}

		if (mode === 'PDU') {
			await this.enableCNMI(prio);
		}
	}

	/*
	 * public functions
	 */

	async open() {
		if (this.port.isOpen) {
			return;
		}

		await new Promise((resolve: (success: true) => void, reject: (error: Error) => void) => {
			this.port.open((error) => {
				if (error !== null) {
					reject(error);
				}

				resolve(true);
			});
		});

		this.events.emit('onOpen');
		this.cmdHandler.startProcessing();

		if (this.options.autoInitOnOpen) {
			await this.initializeModem(true);
		}
	}

	async close() {
		this.cmdHandler.stopProcessing();

		if (!this.port.isOpen) {
			return;
		}

		await new Promise((resolve: (success: true) => void, reject: (error: Error) => void) => {
			this.port.close((error) => {
				if (error !== null) {
					reject(error);
				}

				resolve(true);
			});
		});

		this.events.emit('onClose');
	}

	async executeATCommand(command: string, prio = false, cmdtimeout?: number) {
		return await new Promise((resolve: (response: CommandResponse) => void, reject: (error: Error) => void) => {
			this.cmdHandler.pushToQueue(
				new Command(command, cmdtimeout, (result) => {
					if (result instanceof Error) {
						reject(result);
						return;
					}

					resolve(result);
				}),
				prio
			);
		});
	}

	async initializeModem(prio = true) {
		await this.checkModem(prio);
		await this.resetModem(prio);
		await this.setEchoMode(true, prio);

		if (await this.checkPinRequired(prio)) {
			if (this.pinCode === null) {
				throw new Error(`serialport-gsm/${this.port.path}: The modem needs a pin!`);
			}

			await this.providePin(prio);
		}

		const initCommand = this.options.customInitCommand !== null ? this.options.customInitCommand : 'AT+CMEE=1;+CREG=2';
		const response = await simplifyResponse(this.executeATCommand(initCommand, prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Initialization of the modem failed`);
		}

		await this.setMode('PDU', prio);
		await this.enableClip(prio);

		this.events.emit('onInitialized');
	}

	async checkModem(prio = false): Promise<{ status: 'OK' }> {
		const response = await simplifyResponse(this.executeATCommand('AT', prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Check modem failed because the response from the modem was invalid!`);
		}

		return { status: 'OK' };
	}

	async sendSms(number: string, message: string, flashSms = false, prio = false): Promise<SendSmsSuccess> {
		const messageID = `${Date.now()}`;

		const submit = new pdu.Submit(number, message);
		submit.dataCodingScheme.setUseMessageClass(flashSms);

		const checkReponse = (response: CommandResponse | Error) => {
			if (response instanceof Error || resultCode(response.pop() || '') !== 'OK') {
				throw new Error(`serialport-gsm/${this.port.path}: Failed to send SMS!`);
			}
		};

		const cmdSequence: CmdStack = {
			cmds: submit
				.getParts()
				.flatMap((part) => [
					new Command(`AT+CMGS=${part.toString(submit).length / 2 - 1}`, 250, undefined, false),
					new Command(part.toString(submit) + '\x1a', 10000, checkReponse)
				]),
			cancelOnFailure: true
		};

		await new Promise((resolve: (success: true) => void, reject: (error: Error) => void) => {
			cmdSequence.onFinish = () => resolve(true);

			cmdSequence.onFailed = (error) => {
				const result: SendSmsFailed = {
					success: false,
					messageID,
					error
				};

				this.events.emit('onSmsSentFailed', result);
				reject(error);
			};

			this.cmdHandler.pushToQueue(cmdSequence, prio);
		});

		const result: SendSmsSuccess = {
			success: true,
			messageID,
			data: {
				message,
				recipient: number,
				alert: flashSms,
				pdu: submit
			}
		};

		this.events.emit('onSmsSent', result);
		return result;
	}

	async getSignalInfo(prio = false) {
		const response = await this.executeATCommand('AT+CSQ', prio);

		if (resultCode(response.pop() || '') !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: The network signal could not be read!`);
		}

		const signal = Number(response[0]?.match(/(\d+)(,\d+)?/g)?.[0]?.replace(',', '.') || NaN);

		if (isNaN(signal) || signal < 0 || signal > 31) {
			throw new Error(`serialport-gsm/${this.port.path}: The signal strength could not be parsed!`);
		}

		return {
			signalQuality: signal,
			signalStrength: 113 - signal * 2
		};
	}

	async checkSimMemory(prio = false) {
		const response = await this.executeATCommand('AT+CPMS="SM"', prio);

		if (resultCode(response.pop() || '') !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: The required memory space of the SMS, could not be read!`);
		}

		const used = Number(response[0]?.match(/\d+/g)?.[0] || NaN);
		const total = Number(response[0]?.match(/\d+/g)?.[1] || NaN);

		if (isNaN(used) || isNaN(total)) {
			throw new Error(`serialport-gsm/${this.port.path}: The required memory space of the SMS, could not be parsed!`);
		}

		const result = { used, total };

		if (result.used >= result.total) {
			this.events.emit('onMemoryFull', result);
		}

		return result;
	}

	async selectPhonebookStorage(prio = false) {
		const response = await simplifyResponse(this.executeATCommand('AT+CPBS="ON"', prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: The storage of the phone book could not be selected!`);
		}
	}

	async writeToPhonebook(phoneNumber: string, name: string, prio = false) {
		const response = await simplifyResponse(this.executeATCommand(`AT+CPBW=1,"${phoneNumber}",129,"${name}"`, prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: The entry could not be written in the phone book!`);
		}
	}

	async setOwnPhoneNumber(phoneNumber: string, name = 'OwnNumber', prio = false) {
		await this.selectPhonebookStorage(prio);
		await this.writeToPhonebook(phoneNumber, name, prio);
	}

	async getProductSerialNumber(prio = false) {
		const response = await simplifyResponse(this.executeATCommand('AT+CGSN', prio));

		if (!/^\d+$/.test(response) || response.toUpperCase().includes('ERROR')) {
			throw new Error(`serialport-gsm/${this.port.path}: Cannot read the serial number of the modem!`);
		}

		return response;
	}

	async getOwnNumber(prio = false) {
		const response = await simplifyResponse(this.executeATCommand('AT+CNUM', prio));

		if (!response.toUpperCase().startsWith('+CNUM') || response.toUpperCase().includes('ERROR')) {
			throw new Error(`serialport-gsm/${this.port.path}: The own phone number could not be read!`);
		}

		const regExp = /"(.*?)"/g;
		const splitedResponse = response.split(',');

		const name = regExp.exec(splitedResponse[0] || '')?.[1];
		const phoneNumber = regExp.exec(splitedResponse[1] || '')?.[1];

		if (name === undefined || phoneNumber === undefined) {
			throw new Error(`serialport-gsm/${this.port.path}: The own phone number could not be parsed!`);
		}

		return { name, phoneNumber };
	}

	async hangupCall(prio = false) {
		const response = await simplifyResponse(this.executeATCommand('ATH', prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: The hang up of the call failed!`);
		}
	}

	async sendUSSD(command: string, prio = false) {
		const response = await simplifyResponse(this.executeATCommand(`AT+CUSD=1,"${command}",15`, prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Execution USSD failed failed!`);
		}
	}

	async deleteAllSms(prio = false) {
		const response = await simplifyResponse(this.executeATCommand('AT+CMGD=1,4', prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Deleting all SMS messages failed!`);
		}
	}

	async deleteSms(id: number, prio = false) {
		const response = await simplifyResponse(this.executeATCommand(`AT+CMGD=${id}`, prio));

		if (resultCode(response) !== 'OK') {
			throw new Error(`serialport-gsm/${this.port.path}: Deleting SMS message failed!`);
		}
	}

	async deleteMessage(message: PduSms, prio = false) {
		const indexes = message.referencedSmsIDs?.sort((a, b) => b - a) || [message.index];
		const deleted: number[] = [];
		const failed: number[] = [];

		for (const id of indexes) {
			try {
				await this.deleteSms(id, prio);
				deleted.push(id);
			} catch (e) {
				failed.push(id);
			}
		}

		return { deleted, failed };
	}

	async getSimInbox(prio = false) {
		const reponse = await this.executeATCommand('AT+CMGL=4', prio);

		if (resultCode(reponse.pop() || '') !== 'OK' || reponse.length % 2 !== 0) {
			throw new Error(`serialport-gsm/${this.port.path}: Reading the SMS inbox failed!`);
		}

		let preInformation;
		const result: PduSms[] = [];

		for (const part of reponse) {
			if (part.toUpperCase().startsWith('+CMGL:')) {
				const splitedPart = part.split(',');

				if (!isNaN(Number(splitedPart[1]))) {
					preInformation = {
						index: Number(splitedPart[0].replace('+CMGL: ', '')),
						status: Number(splitedPart[1])
					};

					continue;
				}

				preInformation = {
					index: Number(splitedPart[0].replace('+CMGL: ', '')),
					status: Number(splitedPart[1].replace(/"/g, '')),
					sender: splitedPart[2].replace(/"/g, ''),
					timestamp: splitedPart[4].replace(/"/g, '') + ', ' + splitedPart[5].replace(/"/g, '')
				};

				continue;
			}

			if (preInformation && /[0-9A-Fa-f]{15}/g.test(part)) {
				const pduMessage = pdu.parse(part);

				result.push({
					index: preInformation.index,
					status: preInformation.status,
					sender: pduMessage.address.phone || undefined,
					message: pduMessage instanceof pdu.Report ? '' : pduMessage.data.getText(),
					timestamp: pduMessage instanceof pdu.Deliver ? pduMessage.serviceCenterTimeStamp.getIsoString() : undefined,
					pdu: pduMessage
				});

				continue;
			}
		}

		if (this.options.enableConcatenation) {
			const pduSms = new Map<number, PduSms>();
			const notConnectable = [];

			for (const item of result) {
				if (item.pdu instanceof pdu.Report) {
					notConnectable.push(item);
					continue;
				}

				const pointer = item.pdu.data.parts[0]?.header?.getPointer();

				if (!pointer) {
					continue;
				}

				const existingReference = pduSms.get(pointer);

				if (!existingReference || existingReference.pdu instanceof pdu.Report) {
					pduSms.set(pointer, item);
					continue;
				}

				existingReference.pdu.data.append(item.pdu);

				pduSms.set(
					pointer,
					Object.assign(existingReference, {
						message: existingReference.pdu.data.getText(),
						referencedSmsIDs: [...(existingReference.referencedSmsIDs || []), item.index]
					})
				);
			}

			return [...Array.from(pduSms.values()), ...notConnectable];
		}

		return result;
	}

	/*
	 * bind the events
	 */

	on = this.events.on.bind(this.events);
	once = this.events.once.bind(this.events);
	removeListener = this.events.removeListener.bind(this.events);
}
