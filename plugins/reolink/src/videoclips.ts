import { VODTrigger, FLAGS_MAPPING, FLAGS_LENGTH } from './types';

const decodeHexToFlags = (hexValue, version, devType) => {
    const hexInt = parseInt(hexValue, 16);
    const hexIntRev = parseInt(hexInt.toString(2).padStart(hexValue.length * 4, '0').split('').reverse().join(''), 2); // reverse the binary
    const flagValues = {};

    for (const [flag, [bitPosition, bitSize]] of Object.entries(FLAGS_MAPPING[devType][version])) {
        const mask = ((1 << bitSize) - 1) << bitPosition;
        const flagValRev = (hexIntRev & mask) >> bitPosition;
        flagValues[flag] = parseInt(flagValRev.toString(2).padStart(bitSize, '0').split('').reverse().join(''), 2); // reverse the segment back
    }

    return flagValues;
}

export const parseFileName = (fileName: string, console: Console) => {
    // Mp4Record/2023-04-26/RecS02_DST20230426_145918_150032_2B14808_32F1DF.mp4
    // Mp4Record/2020-12-22/RecM01_20201222_075939_080140_6D28808_1A468F9.mp4
    // "/mnt/sda/<UID>-<NAME>/Mp4Record/2024-08-27/RecM02_DST20240827_090302_090334_0_800_800_033C820000_61B6F0.mp4"
    // https://github.com/sven337/ReolinkLinux/wiki/Figuring-out-the-file-names

    const [pathName, ext] = fileName.split('.').slice(0, -1).join('.').split('/').slice(-1).concat(fileName.split('.').pop());
    const name = pathName.split('/').pop();
    const split = name.split('_');

    if (!split[0].startsWith("Rec") || split[0].length !== 6) {
        console.debug(`${fileName} does not match known formats, could not find version`);
        return null;
    }
    let version = parseInt(split[0][5]);

    let devType = "cam";
    let startDate, startTime, endTime, hexValue, fileSize;

    if (split.length === 6) {
        // RecM01_20201222_075939_080140_6D28808_1A468F9
        // const [_, startDate, startTime, endTime, hexValue, fileSize] = split;
        startDate = split[1];
        startTime = split[2];
        endTime = split[3];
        hexValue = split[4];
        fileSize = split[5];
    } else if (split.length === 9) {
        // RecM02_DST20240827_090302_090334_0_800_800_033C820000_61B6F0
        devType = "hub";
        // const [_, startDate, startTime, endTime, _animalType, _width, _height, hexValue, fileSize] = split;
        startDate = split[1];
        startTime = split[2];
        endTime = split[3];
        hexValue = split[7];
        fileSize = split[8];
    } else {
        console.debug(`${fileName} does not match known formats, unknown length`);
        return null;
    }

    if (!FLAGS_MAPPING[devType].hasOwnProperty(version)) {
        const newVersion = Math.max(...Object.keys(FLAGS_MAPPING[devType]).map(Number));
        console.debug(`${fileName} has version ${version}, with hex length ${hexValue.length} which is not yet known, using version ${newVersion} instead`);
        version = newVersion;
    }

    if (hexValue.length !== (FLAGS_LENGTH[devType][version] || 0)) {
        console.debug(`${fileName} with version ${version} has unexpected hex length ${hexValue.length}, expected ${FLAGS_LENGTH[devType][version] || 0}`);
    }

    const flagValues = decodeHexToFlags(hexValue, version, devType);
    console.log(hexValue, version, devType, flagValues);

    let detectionClasses: string[] = [];
    if (flagValues["ai_pd"]) detectionClasses.push('person');
    if (flagValues["ai_vd"]) detectionClasses.push('vehicle');
    if (flagValues["ai_ad"]) detectionClasses.push('animal');
    if (flagValues["is_motion_record"]) detectionClasses.push('motion');
    if (flagValues["package_event"]) detectionClasses.push('package');
    // if (flagValues["is_schedule_record"]) triggers |= VODTrigger.TIMER;
    // if (flagValues["is_doorbell_record"]) triggers |= VODTrigger.DOORBELL;
    // if (flagValues["package_event"]) triggers |= VODTrigger.PACKAGE;

    // startDate = startDate.toLowerCase().replace("dst", "");
    // const start = new Date(`${startDate}${startTime.slice(0, 2)}:${startTime.slice(2, 4)}:${startTime.slice(4)}`);
    // const end = endTime !== "000000" ? new Date(`${startDate}${endTime.slice(0, 2)}:${endTime.slice(2, 4)}:${endTime.slice(4)}`) : start;

    if(!detectionClasses.length) {
        detectionClasses.push('motion');
    }
    return {
        // name,
        // ext,
        // date: start.toISOString().split('T')[0],
        // start: start.toTimeString().split(' ')[0],
        // end: end.toTimeString().split(' ')[0],
        detectionClasses,
    }
}

