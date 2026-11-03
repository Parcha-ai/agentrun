import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const run = (c, args) => execFileSync(c, args, { encoding: 'utf8' }).trim();
const paths = ['packages/pi-browser/src/recorder/track.ts', 'packages/pi-browser/dist/recorder/track.js', 'packages/pi-browser/test/frame_track.test.mjs'];
const result = { os: /^PRETTY_NAME="([^"\n]+)"/m.exec(readFileSync('/etc/os-release','utf8'))[1], node: process.version, npm: run('npm',['--version']), user: run('id',[]), glibc: run('getconf',['GNU_LIBC_VERSION']), ffmpeg: run('ffmpeg',['-version']).split('\n')[0], ffprobe: run('ffprobe',['-version']).split('\n')[0], packages: run('dpkg-query',['-W','-f=${Package} ${Version}\n','ca-certificates','ffmpeg','ghostscript','git','libvpx9','openssl','poppler-utils','procps','python3']).split('\n'), sha256: Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(readFileSync(`/workspace/${p}`)).digest('hex')])) };
writeFileSync('/evidence/environment.json', JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result));
