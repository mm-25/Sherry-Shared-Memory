import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("native Claude reader keeps permission/origin checks for article and numbered-message layouts",{skip:process.platform!=="darwin"},async(t)=>{
  const home=await mkdtemp(join(tmpdir(),"sherry-claude-reader-"));t.after(()=>rm(home,{recursive:true,force:true}));
  const binary=join(home,"reader-test");
  const build=spawnSync("clang",["-fobjc-arc","-Wall","-Wextra","-Wno-unused-function",fileURLToPath(new URL("fixtures/claude-ax-harness.m",import.meta.url)),"-o",binary,"-framework","Foundation","-framework","ApplicationServices"],{encoding:"utf8",timeout:30000});
  assert.equal(build.status,0,build.stderr);
  const run=spawnSync(binary,[],{encoding:"utf8",timeout:5000});
  assert.equal(run.status,0,run.stderr);
});
