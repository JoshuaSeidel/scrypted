import { sleep } from '@scrypted/common/src/sleep';
import sdk, { Camera, Device, DeviceCreatorSettings, DeviceInformation, DeviceProvider, FFmpegInput, HttpRequest, HttpRequestHandler, HttpResponse, Intercom, MediaObject, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, PanTiltZoom, PanTiltZoomCommand, Reboot, RequestPictureOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from "@scrypted/sdk";
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { EventEmitter } from "stream";
import { createRtspMediaStreamOptions, Destroyable, RtspProvider, RtspSmartCamera, UrlMediaStreamOptions } from "../../rtsp/src/rtsp";
import { OnvifCameraAPI, OnvifEvent, connectCameraAPI } from './onvif-api';
import { listenEvents } from './onvif-events';
import { OnvifIntercom } from './onvif-intercom';
import { DevInfo } from './probe';
import { AIState, Enc, ReolinkCameraClient, VideoSearchResult, VideoSearchTime } from './reolink-api';
import fs from "fs"
import url from "url"
import path from 'path';
import stream from 'stream';
import { finished } from "stream/promises";
import { httpFetch } from '../../../server/src/fetch/http-fetch';

const REOLINK_CLIPS = path.join(process.env.SCRYPTED_PLUGIN_VOLUME, 'clips');
const REOLINK_THUMBNAILS = path.join(process.env.SCRYPTED_PLUGIN_VOLUME, 'thumbnails');

class ReolinkCameraSiren extends ScryptedDeviceBase implements OnOff {
    sirenTimeout: NodeJS.Timeout;

    constructor(public camera: ReolinkCamera, nativeId: string) {
        super(nativeId);
        this.on = false;
    }

    async turnOff() {
        this.on = false;
        await this.setSiren(false);
    }

    async turnOn() {
        this.on = true;
        await this.setSiren(true);
    }

    private async setSiren(on: boolean) {
        const api = await this.camera.getClient();

        // doorbell doesn't seem to support alarm_mode = 'manul'
        if (this.camera.storageSettings.values.doorbell) {
            if (!on) {
                clearInterval(this.sirenTimeout);
                await api.setSiren(false);
                return;
            }

            // siren lasts around 4 seconds.
            this.sirenTimeout = setTimeout(async () => {
                await this.turnOff();
            }, 4000);

            await api.setSiren(true, 1);
            return;
        }
        await api.setSiren(on);
    }
}

export class ReolinkCamera extends RtspSmartCamera implements Camera, DeviceProvider, Reboot, Intercom, ObjectDetector, PanTiltZoom, VideoClips {
    client: ReolinkCameraClient;
    onvifClient: OnvifCameraAPI;
    onvifIntercom = new OnvifIntercom(this);
    videoStreamOptions: Promise<UrlMediaStreamOptions[]>;
    motionTimeout: NodeJS.Timeout;
    siren: ReolinkCameraSiren;
    videoclipsToFetch: string[] = [];

    storageSettings = new StorageSettings(this, {
        doorbell: {
            title: 'Doorbell',
            description: 'This camera is a Reolink Doorbell.',
            type: 'boolean',
        },
        rtmpPort: {
            subgroup: 'Advanced',
            title: 'RTMP Port Override',
            placeholder: '1935',
            type: 'number',
        },
        motionTimeout: {
            subgroup: 'Advanced',
            title: 'Motion Timeout',
            defaultValue: 20,
            type: 'number',
        },
        hasObjectDetector: {
            json: true,
            hide: true,
        },
        ptz: {
            subgroup: 'Advanced',
            title: 'PTZ Capabilities',
            choices: [
                'Pan',
                'Tilt',
                'Zoom',
            ],
            multiple: true,
            onPut: async () => {
                await this.updateDevice();
                this.updatePtzCaps();
            },
        },
        presets: {
            subgroup: 'Advanced',
            title: 'Presets',
            description: 'PTZ Presets in the format "id=name". Where id is the PTZ Preset identifier and name is a friendly name.',
            multiple: true,
            defaultValue: [],
            combobox: true,
            onPut: async (ov, presets: string[]) => {
                const caps = {
                    ...this.ptzCapabilities,
                    presets: {},
                };
                for (const preset of presets) {
                    const [key, name] = preset.split('=');
                    caps.presets[key] = name;
                }
                this.ptzCapabilities = caps;
            },
            mapGet: () => {
                const presets = this.ptzCapabilities?.presets || {};
                return Object.entries(presets).map(([key, name]) => key + '=' + name);
            },
        },
        cachedPresets: {
            multiple: true,
            hide: true,
            json: true,
            defaultValue: [],
        },
        deviceInfo: {
            json: true,
            hide: true
        },
        abilities: {
            json: true,
            hide: true
        },
        useOnvifDetections: {
            subgroup: 'Advanced',
            title: 'Use ONVIF for Object Detection',
            choices: [
                'Default',
                'Enabled',
                'Disabled',
            ],
            defaultValue: 'Default',
        },
        useOnvifTwoWayAudio: {
            subgroup: 'Advanced',
            title: 'Use ONVIF for Two-Way Audio',
            type: 'boolean',
        },
        token: {
            title: 'Token',
            type: 'string',
            // readonly: true,
            // hide: true,
        },
        tokenLease: {
            title: 'Token lease',
            type: 'number',
            // readonly: true,
            // hide: true,
        }
    });

    constructor(nativeId: string, provider: RtspProvider) {
        super(nativeId, provider);

        this.storageSettings.settings.useOnvifTwoWayAudio.onGet = async () => {
            return {
                hide: !!this.storageSettings.values.doorbell,
            }
        };

        this.storageSettings.settings.ptz.onGet = async () => {
            return {
                hide: !!this.storageSettings.values.doorbell,
            }
        };

        this.storageSettings.settings.presets.onGet = async () => {
            const choices = this.storageSettings.values.cachedPresets.map((preset) => preset.id + '=' + preset.name);
            return {
                choices,
            };
        };

        this.updateDeviceInfo();
        (async () => {
            this.updatePtzCaps();
            try {
                await this.getPresets();
            } catch (e) {
                this.console.log('Fail fetching presets', e);
            }
            const api = await this.getClient();
            const deviceInfo = await api.getDeviceInfo();
            this.storageSettings.values.deviceInfo = deviceInfo;
            await this.updateAbilities();
            await this.updateDevice();
            if (this.hasSiren()) {
                this.reportSirenDevice();
            }
            else {
                sdk.deviceManager.onDevicesChanged({
                    providerNativeId: this.nativeId,
                    devices: []
                });
            }
            await this.initFolders();
        })()
            .catch(e => {
                this.console.log('device refresh failed', e);
            });
    }

    private async initFolders() {
        if (!fs.existsSync(REOLINK_CLIPS)) {
            this.console.log(`Creating clips dir at: ${REOLINK_CLIPS}`)
            fs.mkdirSync(REOLINK_CLIPS);
        }
        if (!fs.existsSync(REOLINK_THUMBNAILS)) {
            this.console.log(`Creating thumbnails dir at: ${REOLINK_THUMBNAILS}`)
            fs.mkdirSync(REOLINK_THUMBNAILS);
        }
        setInterval(async () => {
            if (this.videoclipsToFetch.length) {
                this.console.log(`Fetching ${this.videoclipsToFetch.length} clips`);

                do {
                    const videoClipPath = this.videoclipsToFetch.shift();
                    try {
                        await this.fetchAndSaveClip(videoClipPath);
                    } catch (e) {
                        this.videoclipsToFetch.push(videoClipPath);
                    }
                } while (this.videoclipsToFetch.length > 0);
            }
        }, 2000);
    }

    public async getTokenData() {
        const token = this.storageSettings.getItem('token');
        const tokenLease = this.storageSettings.getItem('tokenLease');

        return { token, tokenLease }
    }

    public async putTokenData(token: string, tokenLease: number) {
        await this.storageSettings.putSetting('token', token);
        await this.storageSettings.putSetting('tokenLease', tokenLease);
    }

    updatePtzCaps() {
        const { ptz } = this.storageSettings.values;
        this.ptzCapabilities = {
            ...this.ptzCapabilities,
            pan: ptz?.includes('Pan'),
            tilt: ptz?.includes('Tilt'),
            zoom: ptz?.includes('Zoom'),
        }
    }

    async getPresets() {
        const client = await this.getClient();
        const ptzPresets = await client.getPtzPresets();
        this.console.log(`Presets: ${JSON.stringify(ptzPresets)}`)
        this.storageSettings.values.cachedPresets = ptzPresets;
    }

    async updateAbilities() {
        const api = await this.getClient();
        const abilities = await api.getAbility();
        this.storageSettings.values.abilities = abilities;
        this.console.log('getAbility', JSON.stringify(abilities));
    }

    supportsOnvifDetections() {
        const onvif: string[] = [
            // wifi
            'CX410W',
            'Reolink Video Doorbell WiFi',

            // poe
            'CX410',
            'CX810',
            'Reolink Video Doorbell PoE',
        ];
        return onvif.includes(this.storageSettings.values.deviceInfo?.model);
    }

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        return;
    }

    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
        const client = await this.getClient();
        client.ptz(command);
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        try {
            const ai: AIState = this.storageSettings.values.hasObjectDetector?.value;
            const classes: string[] = [];

            for (const key of Object.keys(ai)) {
                if (key === 'channel')
                    continue;
                const { alarm_state, support } = ai[key];
                if (support)
                    classes.push(key);
            }
            return {
                classes,
            };
        }
        catch (e) {
            return {
                classes: [],
            };
        }
    }

    async startIntercom(media: MediaObject): Promise<void> {
        if (!this.onvifIntercom.url) {
            const client = await this.getOnvifClient();
            const streamUrl = await client.getStreamUrl();
            this.onvifIntercom.url = streamUrl;
        }
        return this.onvifIntercom.startIntercom(media);
    }

    stopIntercom(): Promise<void> {
        return this.onvifIntercom.stopIntercom();
    }

    hasSiren() {
        return this.storageSettings.values.abilities?.value?.Ability?.supportAudioAlarm?.ver
            && this.storageSettings.values.abilities?.value?.Ability?.supportAudioAlarm?.ver !== 0;
    }

    hasBattery() {
        const channel = this.getRtspChannel();
        const mainBattery = this.storageSettings.values.abilities?.value?.Ability?.battery;
        const channelBattery = this.storageSettings.values.abilities?.value?.abilityChn?.[channel]?.battery;

        return (mainBattery || channelBattery)?.ver !== 0;
    }

    async updateDevice() {
        const interfaces = this.provider.getInterfaces();
        let type = ScryptedDeviceType.Camera;
        let name = 'Reolink Camera';
        if (this.storageSettings.values.doorbell) {
            interfaces.push(
                ScryptedInterface.BinarySensor,
            );
            type = ScryptedDeviceType.Doorbell;
            name = 'Reolink Doorbell';
        }
        if (this.storageSettings.values.doorbell || this.storageSettings.values.useOnvifTwoWayAudio) {
            interfaces.push(
                ScryptedInterface.Intercom
            );
        }

        if (this.storageSettings.values.ptz?.length) {
            interfaces.push(ScryptedInterface.PanTiltZoom);
        }
        if (this.storageSettings.values.hasObjectDetector) {
            interfaces.push(ScryptedInterface.ObjectDetector);
        }
        if (this.hasSiren())
            interfaces.push(ScryptedInterface.DeviceProvider);
        if (this.hasBattery())
            interfaces.push(ScryptedInterface.Battery);

        await this.provider.updateDevice(this.nativeId, name, interfaces, type);
    }

    async reboot() {
        const client = await this.getClient();
        await client.reboot();
    }

    updateDeviceInfo() {
        const ip = this.storage.getItem('ip');
        if (!ip)
            return;
        const info = this.info || {};
        info.ip = ip;
        info.serialNumber = this.storageSettings.values.deviceInfo?.serial;
        info.firmware = this.storageSettings.values.deviceInfo?.firmVer;
        info.version = this.storageSettings.values.deviceInfo?.hardVer;
        info.model = this.storageSettings.values.deviceInfo?.model;
        info.manufacturer = 'Reolink';
        info.managementUrl = `http://${ip}`;
        this.info = info;
    }

    async getClient() {
        if (!this.client) {
            this.client = new ReolinkCameraClient(
                this.getHttpAddress(),
                this.getUsername(),
                this.getPassword(),
                this.getRtspChannel(),
                this.console,
                this,
            );
        }

        return this.client;
    }

    async getOnvifClient() {
        if (!this.onvifClient)
            this.onvifClient = await this.createOnvifClient();
        return this.onvifClient;
    }

    createOnvifClient() {
        return connectCameraAPI(this.getHttpAddress(), this.getUsername(), this.getPassword(), this.console, this.storageSettings.values.doorbell ? this.storage.getItem('onvifDoorbellEvent') : undefined);
    }

    async listenEvents() {
        let killed = false;
        const client = await this.getClient();

        // reolink ai might not trigger motion if objects are detected, weird.
        const startAI = async (ret: Destroyable, triggerMotion: () => void) => {
            let hasSucceeded = false;
            let hasSet = false;
            while (!killed) {
                try {
                    const ai = await client.getAiState();
                    ret.emit('data', JSON.stringify(ai.data));

                    const classes: string[] = [];

                    for (const key of Object.keys(ai.value)) {
                        if (key === 'channel')
                            continue;
                        const { alarm_state, support } = ai.value[key];
                        if (support)
                            classes.push(key);
                    }

                    if (!classes.length)
                        return;


                    if (!hasSet) {
                        hasSet = true;
                        this.storageSettings.values.hasObjectDetector = ai;
                    }

                    hasSucceeded = true;
                    const od: ObjectsDetected = {
                        timestamp: Date.now(),
                        detections: [],
                    };
                    for (const c of classes) {
                        const { alarm_state } = ai.value[c];
                        if (alarm_state) {
                            od.detections.push({
                                className: c,
                                score: 1,
                            });
                        }
                    }
                    if (od.detections.length) {
                        triggerMotion();
                        sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, od);
                    }
                }
                catch (e) {
                    if (!hasSucceeded)
                        return;
                    ret.emit('error', e);
                }
                await sleep(1000);
            }
        }

        const useOnvifDetections: boolean = (this.storageSettings.values.useOnvifDetections === 'Default'
            && (this.supportsOnvifDetections() || this.storageSettings.values.doorbell))
            || this.storageSettings.values.useOnvifDetections === 'Enabled';
        if (useOnvifDetections) {
            const ret = await listenEvents(this, await this.createOnvifClient(), this.storageSettings.values.motionTimeout * 1000);
            ret.on('onvifEvent', (eventTopic: string, dataValue: any) => {
                let className: string;
                if (eventTopic.includes('PeopleDetect')) {
                    className = 'people';
                }
                else if (eventTopic.includes('FaceDetect')) {
                    className = 'face';
                }
                else if (eventTopic.includes('VehicleDetect')) {
                    className = 'vehicle';
                }
                else if (eventTopic.includes('DogCatDetect')) {
                    className = 'dog_cat';
                }
                else if (eventTopic.includes('Package')) {
                    className = 'package';
                }
                if (className && dataValue) {
                    ret.emit('event', OnvifEvent.MotionStart);

                    const od: ObjectsDetected = {
                        timestamp: Date.now(),
                        detections: [
                            {
                                className,
                                score: 1,
                            }
                        ],
                    };
                    sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, od);
                }
                else {
                    ret.emit('event', OnvifEvent.MotionStop);
                }
            });

            ret.on('close', () => killed = true);
            ret.on('error', () => killed = true);
            return ret;
        }

        const events = new EventEmitter();
        const ret: Destroyable = {
            on: function (eventName: string | symbol, listener: (...args: any[]) => void): void {
                events.on(eventName, listener);
            },
            destroy: function (): void {
                killed = true;
            },
            emit: function (eventName: string | symbol, ...args: any[]): boolean {
                return events.emit(eventName, ...args);
            }
        };

        const triggerMotion = () => {
            this.motionDetected = true;
            clearTimeout(this.motionTimeout);
            this.motionTimeout = setTimeout(() => this.motionDetected = false, this.storageSettings.values.motionTimeout * 1000);
        };
        (async () => {
            while (!killed) {
                try {
                    const { value, data } = await client.getMotionState();
                    if (value)
                        triggerMotion();
                    ret.emit('data', JSON.stringify(data));
                }
                catch (e) {
                    ret.emit('error', e);
                }
                await sleep(1000);
            }
        })();
        startAI(ret, triggerMotion);
        return ret;
    }

    async takeSmartCameraPicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const client = await this.getClient();
        return this.createMediaObject(client.jpegSnapshot(options?.timeout), 'image/jpeg');
    }

    async getUrlSettings(): Promise<Setting[]> {
        return [
            {
                key: 'rtspChannel',
                title: 'Channel Number Override',
                subgroup: 'Advanced',
                description: "The channel number to use for snapshots and video. E.g., 0, 1, 2, etc.",
                placeholder: '0',
                type: 'number',
                value: this.getRtspChannel(),
            },
            ...await super.getUrlSettings(),
        ]
    }

    getRtspChannel() {
        return parseInt(this.storage.getItem('rtspChannel')) || 0;
    }

    createRtspMediaStreamOptions(url: string, index: number) {
        const ret = createRtspMediaStreamOptions(url, index);
        ret.tool = 'scrypted';
        return ret;
    }

    addRtspCredentials(rtspUrl: string) {
        const url = new URL(rtspUrl);
        if (url.protocol !== 'rtmp:') {
            url.username = this.storage.getItem('username');
            url.password = this.storage.getItem('password') || '';
        } else {
            const params = url.searchParams;
            params.set('token', this.storageSettings.values.token);
        }
        return url.toString();
    }

    async createVideoStream(vso: UrlMediaStreamOptions): Promise<MediaObject> {
        await this.client.getTokenData();
        return super.createVideoStream(vso);
    }

    async getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        this.videoStreamOptions ||= this.getConstructedVideoStreamOptionsInternal().catch(e => {
            this.constructedVideoStreamOptions = undefined;
            throw e;
        });

        return this.videoStreamOptions;
    }

    async getConstructedVideoStreamOptionsInternal(): Promise<UrlMediaStreamOptions[]> {
        let deviceInfo: DevInfo;
        try {
            const client = await this.getClient();
            deviceInfo = await client.getDeviceInfo();

        } catch (e) {
            this.console.error("Unable to gather device information.", e);
        }

        let encoderConfig: Enc;
        try {
            const client = await this.getClient();
            encoderConfig = await client.getEncoderConfiguration();
        } catch (e) {
            this.console.error("Codec query failed. Falling back to known defaults.", e);
        }

        const channel = (this.getRtspChannel() + 1).toString().padStart(2, '0');

        const streams: UrlMediaStreamOptions[] = [
            {
                name: '',
                id: 'main.bcs',
                container: 'rtmp',
                video: { width: 2560, height: 1920 },
                url: ''
            },
            {
                name: '',
                id: 'ext.bcs',
                container: 'rtmp',
                video: { width: 896, height: 672 },
                url: ''
            },
            {
                name: '',
                id: 'sub.bcs',
                container: 'rtmp',
                video: { width: 640, height: 480 },
                url: ''
            },
            {
                name: '',
                id: `h264Preview_${channel}_main`,
                container: 'rtsp',
                video: { codec: 'h264', width: 2560, height: 1920 },
                url: ''
            },
            {
                name: '',
                id: `h264Preview_${channel}_sub`,
                container: 'rtsp',
                video: { codec: 'h264', width: 640, height: 480 },
                url: ''
            }
        ];

        // abilityChn->live
        // 0: not support
        // 1: support main/extern/sub stream
        // 2: support main/sub stream

        const live = this.storageSettings.values.abilities?.value?.Ability?.abilityChn?.[0].live?.ver;
        const [rtmpMain, rtmpExt, rtmpSub, rtspMain, rtspSub] = streams;
        streams.splice(0, streams.length);

        // abilityChn->mainEncType
        // 0: main stream enc type is H264
        // 1: main stream enc type is H265

        // anecdotally, encoders of type h265 do not have a working RTMP main stream.
        const mainEncType = this.storageSettings.values.abilities?.value?.Ability?.abilityChn?.[0].mainEncType?.ver;

        if (live === 2) {
            if (mainEncType === 1) {
                streams.push(rtmpSub, rtspMain, rtspSub);
            }
            else {
                streams.push(rtmpMain, rtmpSub, rtspMain, rtspSub);
            }
        }
        else if (mainEncType === 1) {
            streams.push(rtmpExt, rtmpSub, rtspMain, rtspSub);
        }
        else {
            streams.push(rtmpMain, rtmpExt, rtmpSub, rtspMain, rtspSub);
        }


        if (deviceInfo?.model == "Reolink TrackMix PoE") {
            streams.push({
                name: '',
                id: 'autotrack.bcs',
                container: 'rtmp',
                video: { width: 896, height: 512 },
                url: '',
            });
        }

        for (const stream of streams) {
            var streamUrl;
            if (stream.container === 'rtmp') {
                streamUrl = new URL(`rtmp://${this.getRtmpAddress()}/bcs/channel${this.getRtspChannel()}_${stream.id}`)
                const params = streamUrl.searchParams;
                params.set("channel", this.getRtspChannel().toString())
                params.set("stream", '0')
                stream.url = streamUrl.toString();
                stream.name = `RTMP ${stream.id}`;
            } else if (stream.container === 'rtsp') {
                streamUrl = new URL(`rtsp://${this.getRtspAddress()}/${stream.id}`)
                stream.url = streamUrl.toString();
                stream.name = `RTSP ${stream.id}`;
            }
        }

        if (encoderConfig) {
            const { mainStream } = encoderConfig;
            if (mainStream?.width && mainStream?.height) {
                for (const stream of streams) {
                    if (stream.id === 'main.bcs' || stream.id === `h264Preview_${channel}_main`) {
                        stream.video.width = mainStream.width;
                        stream.video.height = mainStream.height;
                    }
                    // 4k h265 rtmp is seemingly nonfunctional, but rtsp works. swap them so there is a functional stream.
                    if (mainStream.vType === 'h265' || mainStream.vType === 'hevc') {
                        if (stream.id === `h264Preview_${channel}_main`) {
                            this.console.warn('Detected h265. Change the camera configuration to use 2k mode to force h264. https://docs.scrypted.app/camera-preparation.html#h-264-video-codec');
                            stream.video.codec = 'h265';
                            stream.id = `h265Preview_${channel}_main`;
                            stream.name = `RTSP ${stream.id}`;
                            stream.url = `rtsp://${this.getRtspAddress()}/${stream.id}`;
                            // Per Reolink:
                            // https://support.reolink.com/hc/en-us/articles/360007010473-How-to-Live-View-Reolink-Cameras-via-VLC-Media-Player/
                            // Note: the 4k cameras connected with the 4k NVR system will only show a fluent live stream instead of the clear live stream due to the H.264+(h.265) limit.
                        }
                    }
                }
            }
        }

        return streams;
    }

    async putSetting(key: string, value: string) {
        await this.storageSettings.putSetting(key, value);
        this.updateDevice();
        this.updateDeviceInfo();
    }

    showRtspUrlOverride() {
        return false;
    }

    async getRtspPortOverrideSettings(): Promise<Setting[]> {
        return [
            ...await super.getRtspPortOverrideSettings(),
        ];
    }

    getOtherSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    getRtmpAddress() {
        return `${this.getIPAddress()}:${this.storage.getItem('rtmpPort') || 1935}`;
    }

    reportSirenDevice() {
        const sirenNativeId = `${this.nativeId}-siren`;
        const sirenDevice: Device = {
            providerNativeId: this.nativeId,
            name: 'Reolink Siren',
            nativeId: sirenNativeId,
            info: {
                ...this.info,
            },
            interfaces: [
                ScryptedInterface.OnOff
            ],
            type: ScryptedDeviceType.Siren,
        };

        sdk.deviceManager.onDevicesChanged({
            providerNativeId: this.nativeId,
            devices: [sirenDevice]
        });

        return sirenNativeId;
    }

    private async getVideoclipUrls(videoclipPath: string) {
        const { fileName } = await this.client.getVideoClipUrl(videoclipPath);
        const outputVideoFile = `${REOLINK_CLIPS}/${fileName}.mp4`;
        const outputThumbnailFile = `${REOLINK_THUMBNAILS}/${fileName}.jpg`;

        return { outputVideoFile, outputThumbnailFile }
    }

    async findLocalVideoClip(videoclipPath: string): Promise<MediaObject | undefined> {
        const { outputVideoFile } = await this.getVideoclipUrls(videoclipPath);

        if (fs.existsSync(outputVideoFile)) {
            const fileURLToPath = url.pathToFileURL(outputVideoFile).toString()
            return await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
        }

        return;
    }

    async findLocalThumbnail(videoclipPath: string): Promise<MediaObject | undefined> {
        const { outputThumbnailFile } = await this.getVideoclipUrls(videoclipPath);

        if (fs.existsSync(outputThumbnailFile)) {
            const fileURLToPath = url.pathToFileURL(outputThumbnailFile).toString()
            return await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
        }

        return;
    }

    private async generateVideoThumbnail(videoclipPath) {
        const videoMo = await this.findLocalVideoClip(videoclipPath);
        let thumbnailMo = await this.findLocalThumbnail(videoclipPath);

        try {
            if (!thumbnailMo && videoMo) {
                const { outputVideoFile, outputThumbnailFile } = await this.getVideoclipUrls(videoclipPath);

                const ffmpegInput: FFmpegInput = {
                    url: undefined,
                    inputArguments: [
                        '-ss', '00:00:02',
                        '-i', outputVideoFile,
                    ],
                };
                const input = await sdk.mediaManager.createFFmpegMediaObject(ffmpegInput);
                const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(input, 'image/jpeg');
                await fs.promises.writeFile(outputThumbnailFile, jpeg);

                thumbnailMo = await this.findLocalThumbnail(videoclipPath);
            }

        } catch (e) {
            this.console.log('Error generating thumbnail', e);
        }

        return thumbnailMo;
    }

    private async fetchAndSaveClip(videoclipPath: string) {
        const { url: fileUrl } = await this.client.getVideoClipUrl(videoclipPath);

        let { outputVideoFile } = await this.getVideoclipUrls(videoclipPath);
        let videoMo = await this.findLocalVideoClip(videoclipPath);
        let thumbnailMo = await this.findLocalThumbnail(videoclipPath);

        try {
            if (!fs.existsSync(outputVideoFile)) {
                this.console.log(`Starting clip download from ${fileUrl}`);
                const response = await fetch(fileUrl);
                await finished(stream.Readable.from(response.body as ReadableStream<Uint8Array>).pipe(fs.createWriteStream(outputVideoFile)));
                this.console.log("Download finished.")
            }

            videoMo = await this.findLocalVideoClip(videoclipPath);
        } catch (e) {
            this.console.log('Error fetching clip', e);
        }

        try {
            this.console.log(`Starting thumbnail generation for ${videoclipPath}`);

            // if (!fs.existsSync(outputThumbnailFile)) {
            thumbnailMo = await this.generateVideoThumbnail(videoclipPath);
            // }
        } catch (e) {
            this.console.log('Error fetching clip', e);
        }

        return { videoMo, thumbnailMo };
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        const response = await this.client.getVideoClips(options);

        const processDate = (date: VideoSearchTime) => {
            let timeDate = new Date();

            timeDate.setFullYear(date.year);
            timeDate.setMonth(date.mon - 1);
            timeDate.setDate(date.day);
            timeDate.setHours(date.hour);
            timeDate.setMinutes(date.min);
            timeDate.setSeconds(date.sec);

            return timeDate.getTime();
        }
        const ep = await sdk.endpointManager.getLocalEndpoint();

        const videoclips: VideoClip[] = [];

        for (const videoClip of response) {
            try {
                const startTime = processDate(videoClip.StartTime);
                const entdTime = processDate(videoClip.EndTime);

                const durationInMs = entdTime - startTime;
                const videoClipPath = videoClip.name;

                const videoMo = await this.findLocalVideoClip(videoClipPath);
                const thumbnailMo = await this.findLocalThumbnail(videoClipPath);
                let videoUrl: string;
                let thumbnailUrl: string;

                if (!videoMo) {
                    if (!this.videoclipsToFetch.includes(videoClipPath)) {
                        this.videoclipsToFetch.push(videoClipPath);
                    }
                } else {
                    videoUrl = await sdk.mediaManager.convertMediaObjectToUrl(videoMo, 'video/mp4');
                    if (thumbnailMo) {
                        thumbnailUrl = await sdk.mediaManager.convertMediaObjectToUrl(thumbnailMo, 'image/jpg');
                    }
                    const ep = await sdk.endpointManager.getLocalEndpoint();
                    const event = 'motion';

                    videoclips.push({
                        id: videoClipPath,
                        startTime,
                        duration: Math.round(durationInMs),
                        videoId: videoClipPath,
                        thumbnailId: videoClipPath,
                        // detectionClasses,
                        event,
                        description: event,
                        resources: {
                            thumbnail: {
                                href: thumbnailUrl
                            },
                            video: {
                                href: videoUrl
                            }
                        }
                    })
                }


            } catch (e) {
                this.console.log('error generating clip', e)
            }
        }

        return videoclips;
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        this.console.log('Requiring videoclip ', videoId);

        const { url: videoClipUrl } = await this.client.getVideoClipUrl(videoId);
        const ffmpegInput: FFmpegInput = {
            url: undefined,
            inputArguments: [
                // '-ss', '00:00:02',
                '-i', videoClipUrl,
            ],
        };
        const input = await sdk.mediaManager.createFFmpegMediaObject(ffmpegInput);
        return input;
    }

    async getVideoClipThumbnail(thumbnailId: string, _?: VideoClipThumbnailOptions): Promise<MediaObject> {
        this.console.log('Requiring thumbnail ', thumbnailId);

        const { thumbnailMo } = await this.fetchAndSaveClip(thumbnailId);
        return thumbnailMo;
    }

    async removeVideoClips(...videoClipIds: string[]): Promise<void> {
        throw new Error('Removing video clips not supported.');
    }

    async getDevice(nativeId: string): Promise<any> {
        if (nativeId.endsWith('-siren')) {
            this.siren ||= new ReolinkCameraSiren(this, nativeId);
            return this.siren;
        }
    }

    async releaseDevice(id: string, nativeId: string) {
        if (nativeId.endsWith('-siren')) {
            delete this.siren;
        }
    }
}

class ReolinkProvider extends RtspProvider {
    constructor() {
        super()
    }

    getScryptedDeviceCreator(): string {
        return 'Reolink Camera';
    }

    getAdditionalInterfaces() {
        return [
            ScryptedInterface.Reboot,
            ScryptedInterface.VideoCameraConfiguration,
            ScryptedInterface.Camera,
            ScryptedInterface.AudioSensor,
            ScryptedInterface.MotionSensor,
            ScryptedInterface.VideoClips,
        ];
    }

    async createDevice(settings: DeviceCreatorSettings, nativeId?: string): Promise<string> {
        const httpAddress = `${settings.ip}:${settings.httpPort || 80}`;
        let info: DeviceInformation = {};

        const skipValidate = settings.skipValidate?.toString() === 'true';
        const username = settings.username?.toString();
        const password = settings.password?.toString();
        let doorbell: boolean = false;
        let name: string = 'Reolink Camera';
        let deviceInfo: DevInfo;
        let ai;
        let abilities;
        const rtspChannel = parseInt(settings.rtspChannel?.toString()) || 0;

        nativeId = await super.createDevice(settings, nativeId);
        const device = await this.getDevice(nativeId) as ReolinkCamera;

        if (!skipValidate) {
            const api = new ReolinkCameraClient(
                httpAddress,
                username,
                password,
                rtspChannel,
                this.console,
                device
            );
            try {
                await api.jpegSnapshot();
            }
            catch (e) {
                this.console.error('Error adding Reolink camera', e);
                throw e;
            }

            try {
                deviceInfo = await api.getDeviceInfo();
                doorbell = deviceInfo.type === 'BELL';
                name = deviceInfo.name ?? 'Reolink Camera';
                ai = await api.getAiState();
                abilities = await api.getAbility();
            }
            catch (e) {
                this.console.error('Reolink camera does not support AI events', e);
            }
        }
        settings.newCamera ||= name;

        device.info = info;
        device.putSetting('username', username);
        device.putSetting('password', password);
        device.storageSettings.values.doorbell = doorbell;
        device.storageSettings.values.deviceInfo = deviceInfo;
        device.storageSettings.values.abilities = abilities;
        device.storageSettings.values.hasObjectDetector = ai;
        device.setIPAddress(settings.ip?.toString());
        device.putSetting('rtspChannel', settings.rtspChannel?.toString());
        device.setHttpPortOverride(settings.httpPort?.toString());
        device.updateDeviceInfo();

        return nativeId;
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'username',
                title: 'Username',
            },
            {
                key: 'password',
                title: 'Password',
                type: 'password',
            },
            {
                key: 'ip',
                title: 'IP Address',
                placeholder: '192.168.2.222',
            },
            {
                subgroup: 'Advanced',
                key: 'rtspChannel',
                title: 'Channel Number Override',
                description: "Optional: The channel number to use for snapshots and video. E.g., 0, 1, 2, etc.",
                placeholder: '0',
                type: 'number',
            },
            {
                subgroup: 'Advanced',
                key: 'httpPort',
                title: 'HTTP Port',
                description: 'Optional: Override the HTTP Port from the default value of 80.',
                placeholder: '80',
            },
            {
                subgroup: 'Advanced',
                key: 'skipValidate',
                title: 'Skip Validation',
                description: 'Add the device without verifying the credentials and network settings.',
                type: 'boolean',
            }
        ]
    }

    createCamera(nativeId: string) {
        return new ReolinkCamera(nativeId, this);
    }
}

export default ReolinkProvider;

