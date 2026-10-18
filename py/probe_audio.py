"""Read audio frame counts; never estimate duration from compressed byte size."""
import argparse
import json
import os
import sys

EXTENSIONS = ('.ogg', '.wav', '.mp3', '.flac', '.opus', '.m4a')


def probe(directory, sf):
    files = measured = 0
    seconds = 0.0
    errors = []
    for root, dirs, names in os.walk(directory, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d != '_rejected')
        for name in sorted(names):
            if not name.lower().endswith(EXTENSIONS):
                continue
            files += 1
            try:
                info = sf.info(os.path.join(root, name))
                if info.samplerate <= 0 or info.frames <= 0:
                    raise ValueError('empty audio or invalid sample rate')
                seconds += info.frames / info.samplerate
                measured += 1
            except Exception as error:
                if len(errors) < 5:
                    errors.append({'file': os.path.relpath(os.path.join(root, name), directory),
                                   'error': str(error)})
    complete = files > 0 and files == measured
    return {'dir': directory, 'files': files, 'measuredFiles': measured,
            'failedFiles': files - measured, 'measuredSeconds': seconds,
            'durationSeconds': seconds if complete else None,
            'durationComplete': complete, 'durationMethod': 'audio frames / sample rate',
            'errors': errors}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dirs', nargs='+', required=True)
    args = parser.parse_args()
    try:
        import soundfile as sf
    except ImportError:
        print(json.dumps({'ok': False, 'error': 'Missing soundfile; install it in ddspEnv.'}))
        return 2
    print(json.dumps({'ok': True, 'directories': [probe(d, sf) for d in args.dirs]}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
