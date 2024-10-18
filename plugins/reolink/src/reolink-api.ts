import { AuthFetchCredentialState, authHttpFetch } from '@scrypted/common/src/http-auth-fetch';
import { PassThrough, Readable } from 'stream';
import { HttpFetchOptions } from '../../../server/src/fetch/http-fetch';

import { sleep } from "@scrypted/common/src/sleep";
import { PanTiltZoomCommand, VideoClipOptions } from "@scrypted/sdk";
import { DevInfo, getToken } from './probe';
import { ReolinkCamera } from './main';

export interface Enc {
    audio: number;
    channel: number;
    mainStream: Stream;
    subStream: Stream;
}

export interface Stream {
    bitRate: number;
    frameRate: number;
    gop: number;
    height: number;
    profile: string;
    size: string;
    vType: string;
    width: number;
}

export interface AIDetectionState {
    alarm_state: number;
    support: number;
}

export type AIState = {
    [key: string]: AIDetectionState;
} & {
    channel: number;
};

export type SirenResponse = {
    rspCode: number;
}

export interface PtzPreset {
    id: number;
    name: string;
}

export interface VideoSearchTime {
    day: number;
    hour: number;
    min: number;
    mon: number;
    sec: number;
    year: number;
}

export interface VideoSearchResult {
    EndTime: VideoSearchTime;
    StartTime: VideoSearchTime;
    frameRate: number;
    height: number;
    name: string;
    size: number;
    type: number;
    width: number;
}

export type VideoSearchType = 'sub' | 'main';

export class ReolinkCameraClient {
    credential: AuthFetchCredentialState;

    constructor(
        public host: string,
        public username: string,
        public password: string,
        public channelId: number,
        public console: Console,
        public device: ReolinkCamera
    ) {
        this.credential = {
            username,
            password,
        };
    }

    public async getTokenData() {
        let { token: currentToken, tokenLease: currentTokenLease } = await this.device.getTokenData();

        if (currentTokenLease) {
            currentTokenLease = Number(currentTokenLease);
        }

        if (!currentToken || !currentTokenLease || Date.now() > Number(currentTokenLease)) {
            this.console.log(`token expired, renewing... Token: ${currentToken}, TokenLease: ${currentTokenLease}, Now: ${Date.now()}`);

            try {
                const { leaseTimeSeconds, parameters: { token } } = await getToken(this.host, this.username, this.password);
                const tokenLease = Date.now() + 1000 * leaseTimeSeconds;
                this.console.log(`Token ${token} created. Will expire at ${new Date(tokenLease).toLocaleString()} `);

                await this.device.putTokenData(token, tokenLease);
            } catch (e) {
                this.console.log('error creating token', e)
            }
        }
        return await this.device.getTokenData();
    }

    private async request(options: HttpFetchOptions<Readable>, body?: Readable) {
        const response = await authHttpFetch({
            ...options,
            rejectUnauthorized: false,
            credential: this.credential,
            body,
        });
        return response;
    }

    private createReadable = (data: any) => {
        const pt = new PassThrough();
        pt.write(Buffer.from(JSON.stringify(data)));
        pt.end();
        return pt;
    }

    async requestWithLogin(options: HttpFetchOptions<Readable>, body?: Readable) {
        const { token } = await this.getTokenData();
        const url = options.url as URL;
        const params = url.searchParams;
        params.set('token', String(token));

        const response = await this.request(options, body);

        const error = response.body?.find(item => !!item.error)?.error;

        if (error === -6) {
            this.device.putTokenData(undefined, undefined);
        }

        return response;
    }

    async reboot() {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'Reboot');
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });
        return {
            value: response.body?.[0]?.value?.rspCode,
            data: response.body,
        };
    }

    // [
    //     {
    //        "cmd" : "GetMdState",
    //        "code" : 0,
    //        "value" : {
    //           "state" : 0
    //        }
    //     }
    //  ]
    async getMotionState() {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetMdState');
        params.set('channel', this.channelId.toString());
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });
        return {
            value: !!response.body?.[0]?.value?.state,
            data: response.body,
        };
    }

    async getAiState() {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetAiState');
        params.set('channel', this.channelId.toString());
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });
        return {
            value: (response.body?.[0]?.value || response.body?.value) as AIState,
            data: response.body,
        };
    }

    async getAbility() {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetAbility');
        params.set('channel', this.channelId.toString());

        const body = [{
            cmd: 'GetAbility',
            param: {
                User: {
                    userName: this.username
                }
            }
        }];

        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
            method: 'POST',
        }, this.createReadable(body));
        const error = response.body?.[0]?.error;
        if (error) {
            throw new Error('error during call to getAbilityWithToken');
        }

        return {
            value: response.body?.[0]?.value || response.body?.value,
            data: response.body,
        };
    }

    async jpegSnapshot(timeout = 10000) {
        const url = new URL(`http://${this.host}/cgi-bin/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'Snap');
        params.set('channel', this.channelId.toString());
        params.set('rs', Date.now().toString());

        const response = await this.requestWithLogin({
            url,
            timeout,
        });

        return response.body;
    }

    async getEncoderConfiguration(): Promise<Enc> {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetEnc');
        // is channel used on this call?
        params.set('channel', this.channelId.toString());
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });

        return response.body?.[0]?.value?.Enc;
    }

    async getDeviceInfo(): Promise<DevInfo> {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetDevInfo');
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
        });
        const error = response.body?.[0]?.error;
        if (error) {
            this.console.error('error during call to getDeviceInfo', error);
            throw new Error('error during call to getDeviceInfo');
        }
        return response.body?.[0]?.value?.DevInfo;
    }

    async getPtzPresets(): Promise<PtzPreset[]> {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'GetPtzPreset');
        const body = [
            {
                cmd: "GetPtzPreset",
                action: 1,
                param: {
                    channel: this.channelId
                }
            }
        ];
        const response = await this.requestWithLogin({
            url,
            responseType: 'json',
            method: 'POST'
        }, this.createReadable(body));
        return response.body?.[0]?.value?.PtzPreset?.filter(preset => preset.enable === 1);
    }

    private async ptzOp(op: string, speed: number, id?: number) {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'PtzCtrl');

        const c1 = this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'text',
        }, this.createReadable([
            {
                cmd: "PtzCtrl",
                param: {
                    channel: this.channelId,
                    op,
                    speed,
                    timeout: 1,
                    id
                }
            },
        ]));

        await sleep(500);

        const c2 = this.requestWithLogin({
            url,
            method: 'POST',
        }, this.createReadable([
            {
                cmd: "PtzCtrl",
                param: {
                    channel: this.channelId,
                    op: "Stop"
                }
            },
        ]));

        this.console.log(await c1);
        this.console.log(await c2);
    }

    private async presetOp(speed: number, id: number) {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'PtzCtrl');

        const c1 = this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'text',
        }, this.createReadable([
            {
                cmd: "PtzCtrl",
                param: {
                    channel: this.channelId,
                    op: 'ToPos',
                    speed,
                    id
                }
            },
        ]));
    }

    async ptz(command: PanTiltZoomCommand) {
        // reolink doesnt accept signed values to ptz
        // in favor of explicit direction.
        // so we need to convert the signed values to abs explicit direction.
        if (command.preset && !Number.isNaN(Number(command.preset))) {
            await this.presetOp(1, Number(command.preset));
            return;
        }

        let op = '';
        if (command.pan < 0)
            op += 'Left';
        else if (command.pan > 0)
            op += 'Right'
        if (command.tilt < 0)
            op += 'Down';
        else if (command.tilt > 0)
            op += 'Up';

        if (op) {
            await this.ptzOp(op, Math.ceil(Math.abs(command?.pan || command?.tilt || 1) * 10));
        }

        op = undefined;
        if (command.zoom < 0)
            op = 'ZoomDec';
        else if (command.zoom > 0)
            op = 'ZoomInc';

        if (op) {
            await this.ptzOp(op, Math.ceil(Math.abs(command?.zoom || 1) * 10));
        }
    }

    async setSiren(on: boolean, duration?: number) {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'AudioAlarmPlay');

        let alarmMode;
        if (duration) {
            alarmMode = {
                alarm_mode: 'times',
                times: duration
            };
        }
        else {
            alarmMode = {
                alarm_mode: 'manul',
                manual_switch: on ? 1 : 0
            };
        }

        const response = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json',
        }, this.createReadable([
            {
                cmd: "AudioAlarmPlay",
                action: 0,
                param: {
                    channel: this.channelId,
                    ...alarmMode
                }
            },
        ]));
        return {
            value: (response.body?.[0]?.value || response.body?.value) as SirenResponse,
            data: response.body,
        };
    }

    async getVideoClips(options?: VideoClipOptions, streamType: VideoSearchType = 'main') {
        const url = new URL(`http://${this.host}/api.cgi`);
        const params = url.searchParams;
        params.set('cmd', 'Search');

        const startTime = new Date(options.startTime);
        let endTime = options.endTime ? new Date(options.endTime) : undefined;

        // If the endTime is not the same day as startTime, 
        // or no endDate is provided, set to the end of the startTime
        // Reolink only supports 1 day recordings fetching
        if (!endTime || endTime.getDate() > startTime.getDate()) {
            endTime = new Date(startTime);
            endTime.setHours(23);
            endTime.setMinutes(59);
            endTime.setSeconds(59);
        }

        const response = await this.requestWithLogin({
            url,
            method: 'POST',
            responseType: 'json',
        }, this.createReadable([
            {
                cmd: "Search",
                action: 1,
                param: {
                    Search: {
                        channel: this.channelId,
                        streamType,
                        onlyStatus: 0,
                        StartTime: {
                            year: startTime.getFullYear(),
                            mon: startTime.getMonth() + 1,
                            day: startTime.getDate(),
                            hour: startTime.getHours(),
                            min: startTime.getMinutes(),
                            sec: startTime.getSeconds()
                        },
                        EndTime: {
                            year: endTime.getFullYear(),
                            mon: endTime.getMonth() + 1,
                            day: endTime.getDate(),
                            hour: endTime.getHours(),
                            min: endTime.getMinutes(),
                            sec: endTime.getSeconds()
                        }
                    }
                }
            }
        ]));

        return (response.body?.[0]?.value?.SearchResult?.File ?? []) as VideoSearchResult[];
    }

    async getVideoClipUrl(videoclipPath: string) {
        const { token } = await this.getTokenData();
        if (!token) {
            throw new Error('Token is not available');
        }

        const fileName = videoclipPath.split('/').pop().split('.').shift();

        return {
            url: `http://${this.host}/api.cgi?cmd=Download&source=${videoclipPath}&output=${fileName}&token=${token}`,
            fileName,
        };
    }
}
