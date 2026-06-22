// tests/p3-corpus.test.js — corpus / failures 端到端 + suggest 反馈闭环
const { withTempProject } = require('./withTempProject');

describe('corpus', () => {
  it('append + findByText (dedup hash)', async () => {
    await withTempProject(() => {
      const corpus = require('../lib/memory/corpus');
      const id = corpus.append({ replyText: '谢谢支持', srcCid: 'c1', noteId: 'n1' });
      expect(id).toBeTruthy();
      const hit = corpus.findByText('谢谢支持');
      expect(hit).toBeTruthy();
      expect(hit.replyText).toBe('谢谢支持');
      // normalizeText 不区分大小写/空白
      const hit2 = corpus.findByText('  谢谢支持  ');
      expect(hit2).toBeTruthy();
      expect(corpus.findByText('完全不同')).toBe(null);
    });
  });

  it('recent / search / count', async () => {
    await withTempProject(() => {
      const corpus = require('../lib/memory/corpus');
      corpus.append({ replyText: 'reply A', srcText: 'about apple', noteId: 'n1' });
      corpus.append({ replyText: 'reply B', srcText: 'about banana', noteId: 'n2' });
      expect(corpus.count()).toBe(2);
      expect(corpus.recent({ limit: 10 }).length).toBe(2);
      expect(corpus.recent({ noteId: 'n1' }).length).toBe(1);
      expect(corpus.search('banana').length).toBe(1);
    });
  });
});

describe('failures', () => {
  it('classify produces stable signatures', () => {
    const failures = require('../lib/memory/failures');
    expect(failures.classify({ code: 461 })).toBe('xhs_code=461');
    expect(failures.classify('xhs[461 NO_PERMISSION] no perm')).toBe('xhs_code=461');
    expect(failures.classify('RISK_CONTROL triggered')).toBe('risk_control');
    expect(failures.classify('Bridge Server 未启动 ECONNREFUSED')).toBe('bridge_offline');
    expect(failures.classify('Unauthorized 认证失败')).toBe('bridge_unauthorized');
    expect(failures.classify(null)).toBe('unknown');
  });

  it('record increments hit_count for same signature', async () => {
    await withTempProject(() => {
      const failures = require('../lib/memory/failures');
      failures.record({ code: 461, msg: 'no perm' });
      failures.record('xhs[461 NO_PERMISSION] x');
      failures.record('RISK_CONTROL triggered');
      const top = failures.top();
      const sig461 = top.find(f => f.signature === 'xhs_code=461');
      expect(sig461).toBeTruthy();
      expect(sig461.hitCount).toBe(2);
      expect(failures.count()).toBe(2);
    });
  });

  it('setMitigation updates the signature', async () => {
    await withTempProject(() => {
      const failures = require('../lib/memory/failures');
      failures.record({ code: 461 });
      failures.setMitigation('xhs_code=461', '换关键词重发');
      const r = failures.get('xhs_code=461');
      expect(r.mitigation).toBe('换关键词重发');
    });
  });
});

describe('cmdPost feedback loop (mocked)', () => {
  it('on success appends corpus + markReplied + markPost', async () => {
    await withTempProject(async () => {
      const corpus = require('../lib/memory/corpus');
      const comments = require('../lib/memory/comments');
      const notes = require('../lib/memory/notes');

      // 预置一条评论以便 markReplied
      comments.upsert({ cid: 'cid1', noteId: 'n1', uid: 'u1', text: 'hi' });

      const cmdPost = require('../lib/commands/post');
      const ctx = makeFakeCtx({
        bridge: {
          call: async () => ({ ok: true, value: { code: 0, data: { comment: { id: 'newcid', content: 'thanks' } } } }),
        },
      });
      const res = await cmdPost(ctx, ['n1', 'thanks for reading', '--reply-to', 'cid1']);
      expect(res.cid).toBe('newcid');
      expect(corpus.count()).toBe(1);
      expect(corpus.findByText('thanks for reading')).toBeTruthy();
      expect(comments.get('cid1').replied).toBe(true);
      expect(notes.get('n1').lastPostTs).toBeTruthy();
    });
  });

  it('on xhs envelope failure records failure pattern', async () => {
    await withTempProject(async () => {
      const failures = require('../lib/memory/failures');
      const corpus = require('../lib/memory/corpus');

      const cmdPost = require('../lib/commands/post');
      const ctx = makeFakeCtx({
        bridge: {
          call: async () => ({ ok: true, value: { code: 461, msg: 'no perm' } }),
        },
      });
      await expect(cmdPost(ctx, ['n1', 'this should fail'])).rejects.toThrow();
      expect(corpus.count()).toBe(0);
      expect(failures.count()).toBe(1);
      const top = failures.top();
      expect(top[0].signature).toBe('xhs_code=461');
    });
  });
});

// ── helpers ──
function makeFakeCtx(overrides = {}) {
  const audit = {
    _currentOp: null,
    startOperation() {},
    endOperation() {},
    logApiCall() {},
    setNoLog() {},
    load() { return { sessions: [] }; },
    findLastFetchTime() { return null; },
  };
  return Object.assign({
    bridge: { call: async () => ({ ok: true, value: { code: 0, data: {} } }) },
    audit,
    config: {},
    bridgeCall: async () => ({}),
    loggedCall: async () => ({}),
  }, overrides);
}
