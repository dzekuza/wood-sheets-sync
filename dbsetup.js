#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const env = { ...process.env }

// place Sqlite3 database on volume
// Prisma resolves "file:dev.sqlite" relative to /app/prisma/, so the symlink must live there
const source = '/app/prisma/dev.sqlite'
const target = '/data/dev.sqlite'
if (fs.existsSync('/data')) {
  const sourceExists = fs.existsSync(source)
  const isSymlink = sourceExists && fs.lstatSync(source).isSymbolicLink()
  if (!isSymlink) {
    // If source is a regular file (baked into image) and volume has no DB yet,
    // seed the volume with it so existing data isn't lost on first fix.
    if (sourceExists && !fs.existsSync(target)) {
      fs.copyFileSync(source, target)
    }
    if (sourceExists) fs.unlinkSync(source)
    fs.symlinkSync(target, source)
  }
}
const newDb = !fs.existsSync(target)
if (newDb && process.env.BUCKET_NAME) {
  await exec(`npx litestream restore -config litestream.yml -if-replica-exists ${target}`)
}

// prepare database
await exec('npx prisma migrate deploy')

// launch application
if (process.env.BUCKET_NAME) {
  await exec(`npx litestream replicate -config litestream.yml -exec ${JSON.stringify(process.argv.slice(2).join(' '))}`)
} else {
  await exec(process.argv.slice(2).join(' '))
}

function exec(command) {
  const child = spawn(command, { shell: true, stdio: 'inherit', env })
  return new Promise((resolve, reject) => {
    child.on('exit', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} failed rc=${code}`))
      }
    })
  })
}
