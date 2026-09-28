/* AI 模型设置弹窗：模型列表（名称/供应商/修改/删除）+ 添加/编辑表单
 * 参考 IDE 模型管理交互：列表为主视图，添加/修改进入编辑态，名称默认取模型 ID */
import { useState } from 'react'
import { Modal } from '../Modal'
import { toast } from '../Toast'
import { confirmDialog } from '../ModalHost'
import { IconEdit, IconTrash } from '../icons'
import {
  AI_PRESETS, DEFAULT_AI_SETTINGS, applyProfileToSettings, activeProfileIdOf,
  loadAiProfiles, loadAiSettings, presetIdOf, providerNameOf, saveAiProfiles, saveAiSettings, settingsStorageHint,
} from '../../ai/settings'
import { testConnection, AiError } from '../../ai/transport'
import type { AiProfile } from '../../ai/settings'

type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok'; model: string } | { kind: 'fail'; msg: string }
type View = { kind: 'list' } | { kind: 'edit'; id: string | null }

/** 编辑表单数据（名称 + 端点三要素） */
interface Draft { name: string; baseURL: string; model: string; apiKey: string }

export function AiSettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState(() => loadAiSettings())
  const [profiles, setProfiles] = useState(() => loadAiProfiles())
  const [view, setView] = useState<View>({ kind: 'list' })
  const [draft, setDraft] = useState<Draft>({ name: '', baseURL: '', model: '', apiKey: '' })
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [presetSel, setPresetSel] = useState('')

  const activeId = activeProfileIdOf(settings)

  const patchDraft = (p: Partial<Draft>) => {
    setDraft((old) => ({ ...old, ...p }))
    setTest({ kind: 'idle' }) // 配置变化后重置测试状态
  }

  /* ---------- 列表视图：全局设置（即时生效） ---------- */
  const patchGlobal = (p: Partial<typeof settings>) => {
    setSettings((old) => {
      const next = { ...old, ...p }
      saveAiSettings(next)
      return next
    })
  }

  /* ---------- 列表视图：进入添加 / 修改 ---------- */
  const openEdit = (id: string | null) => {
    setTest({ kind: 'idle' })
    if (id) {
      const p = profiles.find((x) => x.id === id)
      if (!p) return
      setDraft({ name: p.name, baseURL: p.baseURL, model: p.model, apiKey: p.apiKey })
      setPresetSel(presetIdOf(p.baseURL)) // 供应商预设回显（含自定义）
    } else {
      setDraft({ name: '', baseURL: '', model: '', apiKey: '' })
      setPresetSel('')
    }
    setView({ kind: 'edit', id })
  }

  /* ---------- 编辑视图：保存（新增或更新模型） ---------- */
  const saveDraft = () => {
    if (!draft.baseURL.trim() || !draft.model.trim() || !draft.apiKey.trim()) {
      toast.warn('请求地址、模型 ID 与 API Key 均为必填')
      return
    }
    /* 名称默认与模型 ID 相同 */
    const name = draft.name.trim() || draft.model.trim()
    const rec: AiProfile = {
      id: view.kind === 'edit' && view.id ? view.id : `prof_${Date.now().toString(36)}`,
      name, baseURL: draft.baseURL.trim(), model: draft.model.trim(), apiKey: draft.apiKey,
    }
    const isNew = !profiles.some((p) => p.id === rec.id)
    const list = isNew ? [...profiles, rec] : profiles.map((p) => (p.id === rec.id ? rec : p))
    setProfiles(list)
    saveAiProfiles(list)
    /* 编辑的是当前生效模型，或是第一个模型时：同步生效配置 */
    if (rec.id === activeId || (isNew && profiles.length === 0)) {
      const next = applyProfileToSettings(rec.id)
      if (next) setSettings(next)
    }
    toast.success(isNew ? `模型「${name}」已添加` : `模型「${name}」已更新`)
    setView({ kind: 'list' })
  }

  /* ---------- 列表视图：删除模型（应用内二次确认） ---------- */
  const deleteModel = (id: string) => {
    const p = profiles.find((x) => x.id === id)
    if (!p) return
    void confirmDialog({
      title: '删除模型',
      message: `确定删除「${p.name}」吗？删除后需重新配置才能使用该模型。`,
      danger: true,
    }).then((ok) => {
      if (!ok) return
      const list = profiles.filter((x) => x.id !== id)
      setProfiles(list)
      saveAiProfiles(list)
      /* 删除的是生效模型：自动切到列表第一个，没有则清空生效配置 */
      if (id === activeId) {
        if (list.length) {
          const next = applyProfileToSettings(list[0].id)
          if (next) setSettings(next)
        } else {
          const next = { ...loadAiSettings(), activeProfileId: undefined, baseURL: '', model: '', apiKey: '' }
          saveAiSettings(next)
          setSettings(next)
        }
      }
      toast.success(`模型「${p.name}」已删除`)
    })
  }

  /* ---------- 编辑视图：预设 / 测试 ---------- */
  const pickPreset = (id: string) => {
    setPresetSel(id)
    const p = AI_PRESETS.find((x) => x.id === id)
    if (!p || p.id === 'custom') return // 选自定义仅作标记，保留已填写的地址与模型
    patchDraft({ baseURL: p.baseURL, model: p.model })
  }

  const doTest = async () => {
    if (!draft.baseURL.trim() || !draft.model.trim()) { toast.warn('请先填写请求地址与模型 ID'); return }
    setTest({ kind: 'testing' })
    try {
      const model = await testConnection({ ...loadAiSettings(), baseURL: draft.baseURL.trim(), model: draft.model.trim(), apiKey: draft.apiKey })
      setTest({ kind: 'ok', model })
    } catch (e) {
      setTest({ kind: 'fail', msg: e instanceof AiError ? e.message : String(e) })
    }
  }

  const isEditingActive = view.kind === 'edit' && view.id === activeId

  return (
    <Modal
      title="AI 模型设置"
      sub="采用 OpenAI Chat Completions 兼容格式；密钥仅保存在本机，不经过任何第三方"
      width={520} onClose={onClose}
      foot={
        view.kind === 'list' ? (
          <>
            <span className="ai-settings-note">存储位置：{settingsStorageHint()}</span>
            <div className="spacer" />
            <button className="btn primary" onClick={onClose}>完成</button>
          </>
        ) : (
          <>
            <span className="ai-settings-note">存储位置：{settingsStorageHint()}</span>
            <div className="spacer" />
            <button className="btn" onClick={() => setView({ kind: 'list' })}>取消</button>
            <button className="btn" onClick={doTest} disabled={test.kind === 'testing'}>测试连接</button>
            <button className="btn primary" onClick={saveDraft}>保存</button>
          </>
        )
      }
    >
      {view.kind === 'list' ? (
        <>
          {/* 模型列表：添加按钮 + 名称/供应商/操作 */}
          <div className="ai-model-head">
            <span className="ai-model-head-title">模型列表</span>
            <div className="spacer" />
            <button className="btn sm primary" onClick={() => openEdit(null)}>＋ 添加模型</button>
          </div>
          <div className="ai-model-table">
            {profiles.length === 0 ? (
              <div className="ai-model-empty">尚未添加模型，点击右上角「添加模型」开始配置</div>
            ) : (
              <>
                <div className="ai-model-tr ai-model-th">
                  <span>名称</span>
                  <span>供应商</span>
                  <span className="ai-model-ops-h">操作</span>
                </div>
                {profiles.map((p) => (
                  <div key={p.id} className="ai-model-tr">
                    <span className="ai-model-name" title={p.name}>
                      {p.name}
                      {p.id === activeId && <em className="ai-model-live">生效中</em>}
                    </span>
                    <span className="ai-model-vendor" title={p.baseURL}>{providerNameOf(p.baseURL)}</span>
                    <span className="ai-model-ops">
                      <button className="btn sm icon" title="修改" onClick={() => openEdit(p.id)}><IconEdit /></button>
                      <button className="btn sm icon danger" title="删除" onClick={() => deleteModel(p.id)}><IconTrash /></button>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* 全局偏好（与具体模型无关） */}
          <div className="form-grid" style={{ marginTop: 14 }}>
            <label className="lbl">执行策略</label>
            <label className="checkbox-row" title="开启后 SELECT/SHOW 等只读语句由 AI 自动执行；关闭则所有执行都需确认">
              <input type="checkbox" checked={settings.autoRunReadOnly} onChange={(e) => patchGlobal({ autoRunReadOnly: e.target.checked })} />
              只读查询（SELECT/SHOW）自动执行
            </label>

            <label className="lbl">界面动效</label>
            <label className="checkbox-row" title="关闭入口图标的呼吸动效与打字机光标">
              <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => patchGlobal({ reduceMotion: e.target.checked })} />
              减少动效
            </label>

            <label className="lbl" />
            <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? '收起高级选项' : '高级选项…'}
            </button>

            {showAdvanced && (
              <>
                <label className="lbl">Temperature</label>
                <input
                  className="input" type="number" step="0.1" min="0" max="2"
                  value={settings.temperature ?? ''} placeholder="留空使用服务商默认值"
                  onChange={(e) => patchGlobal({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })}
                />
                <label className="lbl">最大 Token</label>
                <input
                  className="input" type="number" step="256" min="1"
                  value={settings.maxTokens ?? ''} placeholder="留空使用服务商默认值"
                  onChange={(e) => patchGlobal({ maxTokens: e.target.value === '' ? undefined : Number(e.target.value) })}
                />
                <label className="lbl">请求超时(ms)</label>
                <input
                  className="input" type="number" step="1000" min="5000"
                  value={settings.timeoutMs ?? DEFAULT_AI_SETTINGS.timeoutMs}
                  onChange={(e) => patchGlobal({ timeoutMs: Number(e.target.value) || 60_000 })}
                />
                <label className="lbl">工具轮次上限</label>
                <input
                  className="input" type="number" step="1" min="1" max="20"
                  value={settings.maxToolRounds} title="AI 单次任务中最多自动执行多少轮工具调用"
                  onChange={(e) => patchGlobal({ maxToolRounds: Math.max(1, Number(e.target.value) || 8) })}
                />
              </>
            )}
          </div>
        </>
      ) : (
        /* 编辑视图：名称默认与模型 ID 相同 */
        <div className="form-grid">
          <label className="lbl">名称</label>
          <input
            className="input" value={draft.name} placeholder="默认与模型 ID 相同"
            onChange={(e) => patchDraft({ name: e.target.value })}
          />

          <label className="lbl">服务商预设</label>
          <select className="select" value={presetSel} onChange={(e) => pickPreset(e.target.value)}>
            <option value="">— 选择预设（或直接手填） —</option>
            {AI_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <label className="lbl">请求地址</label>
          <input
            className="input" value={draft.baseURL} placeholder="https://api.deepseek.com/v1"
            onChange={(e) => { setPresetSel(''); patchDraft({ baseURL: e.target.value }) }}
          />

          <label className="lbl">模型 ID</label>
          <input
            className="input" value={draft.model} placeholder="deepseek-chat"
            onChange={(e) => patchDraft({ model: e.target.value })}
            list="ai-model-options"
          />
          <datalist id="ai-model-options">
            {(AI_PRESETS.find((p) => p.id === presetSel)?.models ?? []).map((m) => <option key={m} value={m} />)}
          </datalist>

          <label className="lbl">API Key</label>
          <input
            className="input" type="password" autoComplete="off" value={draft.apiKey}
            placeholder="sk-…" onChange={(e) => patchDraft({ apiKey: e.target.value })}
          />

          {/* 测试连接结果 */}
          <label className="lbl" />
          <div className="ai-test-result">
            {test.kind === 'testing' && <span className="ai-test testing">正在测试…</span>}
            {test.kind === 'ok' && <span className="ai-test ok">✓ 连接成功（模型 {test.model}）</span>}
            {test.kind === 'fail' && <span className="ai-test fail">{test.msg}</span>}
            {test.kind === 'idle' && <span className="ai-test idle">测试会发送一条 1 token 的最小请求</span>}
          </div>

          {isEditingActive && (
            <>
              <label className="lbl" />
              <span className="ai-test idle">该模型当前生效中，保存后立即应用于对话</span>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
