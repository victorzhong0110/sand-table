// 领域语义进入统一写路径的验证。
//
// 这些规则以前只能住在领域包自己的函数里，调用方要记得调——没有强制点。
// 现在写路径统一走注册表，规则不登记就等于没有要求。
// 契约见 docs/architecture/domain-packs.zh-CN.md。

import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardStore } from "../core/store.ts";
import { registerDomainPack, resetDomainPacks } from "../core/domains.ts";
import type { DomainPack } from "../core/objects.ts";

const empty = {
  objects: [] as never[],
  relations: [] as never[],
  workspaces: [] as never[],
};

function setup() {
  resetDomainPacks();
  const store = new BoardStore();
  const board = store.open(empty, "领域写路径");
  return { store, b: store.get(board.id) };
}

test("推测性关系必须给依据：不给就拒绝", () => {
  const { store, b } = setup();
  const a = store.createContent(b, { type: "text", title: "甲" }, "human");
  const c = store.createContent(b, { type: "text", title: "乙" }, "human");
  assert.throws(
    () =>
      store.relateContent(
        b,
        {
          source: a.id,
          target: c.id,
          kind: "参与",
          status: "inferred",
        },
        "human",
      ),
    /依据/,
    "推测性关系没有依据必须被拒绝",
  );
  assert.throws(
    () =>
      store.relateContent(
        b,
        { source: a.id, target: c.id, kind: "参与", status: "inferred" },
        "human",
      ),
    /依据/,
  );
  /* 给了依据就能建。 */
  const created = store.relateContent(
    b,
    {
      source: a.id,
      target: c.id,
      kind: "参与",
      status: "inferred",
      basis: "作者在第三章提到",
    },
    "human",
  );
  assert.equal(created.status, "inferred");
  assert.equal(created.basis, "作者在第三章提到");
});

test("领域关系规则在写路径上生效：注册了才有要求", () => {
  const pack: DomainPack = {
    id: "test-relations",
    title: "测试关系规则",
    version: 1,
    relationTypes: [
      {
        kind: "支持",
        title: "支持",
        allowsInferred: true,
        check: (relation) =>
          relation.basis?.trim() ? [] : ["支持关系必须写明依据。"],
      },
    ],
  };
  const { store, b } = setup();
  registerDomainPack(pack);
  const a = store.createContent(b, { type: "text", title: "假设" }, "human");
  const c = store.createContent(b, { type: "text", title: "证据" }, "human");
  assert.throws(
    () =>
      store.relateContent(
        b,
        { source: a.id, target: c.id, kind: "支持" },
        "human",
      ),
    /依据/,
    "领域关系规则必须挡住缺依据的关系",
  );
  const ok = store.relateContent(
    b,
    { source: a.id, target: c.id, kind: "支持", basis: "实验数据" },
    "human",
  );
  assert.equal(ok.kind, "支持");
  resetDomainPacks();
});

test("资源引用：登记、失效、撤销都走统一路径", () => {
  const { store, b } = setup();
  const created = store.createResource(
    b,
    {
      id: "ref-1",
      kind: "pdf",
      uri: "file:///papers/attention.pdf",
      fragment: "p.42",
      version: "v1",
      status: "valid",
      fingerprint: "sha256:aaa",
      title: "Attention Is All You Need",
    },
    "human",
  );
  assert.equal(created.status, "valid");
  assert.equal(b.resources.length, 1);

  /* 外部内容变了：状态要能被识别，并且这次变化要可撤销。 */
  store.updateResource(
    b,
    "ref-1",
    { status: "stale", fingerprint: "sha256:bbb" },
    "human",
  );
  assert.equal(b.resources[0].status, "stale");
  assert.equal(b.resources[0].fingerprint, "sha256:bbb");

  store.undo(b.id, "human");
  assert.equal(b.resources[0].status, "valid", "撤销要把引用状态退回去");
  assert.equal(b.resources[0].fingerprint, "sha256:aaa");
  store.redo(b.id, "human");
  assert.equal(b.resources[0].status, "stale", "重做要能再变过去");
});

test("关系可以带外部定位（证据挂在关系上）", () => {
  const { store, b } = setup();
  const a = store.createContent(b, { type: "text", title: "假设" }, "human");
  const c = store.createContent(b, { type: "text", title: "证据" }, "human");
  const relation = store.relateContent(
    b,
    {
      source: a.id,
      target: c.id,
      kind: "支持",
      basis: "见论文第 42 页",
      evidence: [
        { kind: "pdf", uri: "file:///papers/a.pdf", fragment: "p.42" },
      ],
    },
    "human",
  );
  assert.equal(relation.evidence?.length, 1);
  assert.equal(relation.evidence?.[0].fragment, "p.42");
});
