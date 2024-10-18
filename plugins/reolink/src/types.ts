type Flags = Record<string, [number, number]>;

export enum VODTrigger {
    NONE = 0,
    TIMER = 1 << 0,
    MOTION = 1 << 1,
    VEHICLE = 1 << 2,
    ANIMAL = 1 << 3,
    PERSON = 1 << 4,
    DOORBELL = 1 << 5,
    PACKAGE = 1 << 6,
}

export const FLAGS_CAM_V2: Flags = {
    resolution_index: [0, 7],
    tv_system: [7, 1],
    framerate: [8, 7],
    audio_index: [15, 2],
    ai_pd: [17, 1],
    ai_fd: [18, 1],
    ai_vd: [19, 1],
    ai_ad: [20, 1],
    encoder_type_index: [21, 2],
    is_schedule_record: [23, 1],
    is_motion_record: [24, 1],
    is_rf_record: [25, 1],
    is_doorbell_record: [26, 1],
    ai_other: [27, 1],
};

export const FLAGS_HUB_V0: Flags = {
    resolution_index: [0, 7],
    tv_system: [7, 1],
    framerate: [8, 7],
    audio_index: [15, 2],
    ai_pd: [17, 1],
    ai_fd: [18, 1],
    ai_vd: [19, 1],
    ai_ad: [20, 1],
    encoder_type_index: [21, 2],
    is_schedule_record: [23, 1],
    is_motion_record: [24, 1],
    is_rf_record: [25, 1],
    is_doorbell_record: [26, 1],
    is_ai_other_record: [27, 1],
    picture_layout_index: [28, 7],
    package_delivered: [35, 1],
    package_takenaway: [36, 1],
};

export const FLAGS_HUB_V1: Flags = { ...FLAGS_HUB_V0, package_event: [37, 1] };

export const FLAGS_LENGTH = {
    cam: {
        2: 7,
        3: 7,
        4: 9,
        9: 14,
    },
    hub: {
        2: 10,
    },
};

export const FLAGS_MAPPING: Record<string, Record<number, Flags>> = {
    cam: {
        2: FLAGS_CAM_V2,
        3: FLAGS_CAM_V2,
        4: FLAGS_CAM_V2,
        9: FLAGS_CAM_V2,
    },
    hub: {
        0: FLAGS_HUB_V0,
        1: FLAGS_HUB_V1,
        2: {
            resolution_index: [0, 7],
            tv_system: [7, 1],
            framerate: [8, 7],
            audio_index: [15, 2],
            ai_pd: [17, 1],
            ai_fd: [18, 1],
            ai_vd: [19, 1],
            ai_ad: [20, 1],
            ai_other: [21, 2],
            encoder_type_index: [23, 1],
            is_schedule_record: [24, 1],
            is_motion_record: [25, 1],
            is_rf_record: [26, 1],
            is_doorbell_record: [27, 1],
            picture_layout_index: [28, 7],
            package_delivered: [35, 1],
            package_takenaway: [36, 1],
            package_event: [37, 1],
            upload_flag: [38, 1],
        },
    },
};

