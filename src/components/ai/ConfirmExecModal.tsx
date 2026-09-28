/* 执行确认弹窗（M2 确认矩阵）：L1/L2/L3 一律弹窗；L0 未放行时也弹窗。
 * 「记住此语句」仅 L0 可选，本会话内自动放行同语句。 */
import { useEffect, useState } from 'react'
import { Modal } from '../Modal'
import { useAiStore } from '../../ai/store'
import { riskLabel } from '../../ai/agent/guard'
import type { RiskLevel } from '../../ai/types'

/** 风险等级徽章样式类 */
const LEVEL_CLS: Record<RiskLevel, string> = {
  0: 'ai-risk l0',
  1: 'ai-risk l1',
  2: 'ai-risk l2',
  3: 'ai-risk l3',
}

export function ConfirmExecModal() {
  const pending = useAiStore((s) => s.pendingConfirm)
  const [remember, setRemember] = useState(false)

  /* 每个新的待确认请求重置勾选 */
  useEffect(() => {
    setRemember(false)
  }, [pending?.id])

  if (!pending) return null

  const decide = (d: 'run' | 'deny') => {
    useAiStore.getState().resolveConfirm(d, remember && pending.level === 0)
    setRemember(false)
  }

  return (
    <Modal
      title="确认执行 SQL"
      sub={pending.schema ? `目标 Schema：${pending.schema}` : '将在当前连接上执行'}
      width={560}
      onClose={() => decide('deny')}
      foot={
        <>
          <button className="btn" onClick={() => decide('deny')}>拒绝</button>
          <button className={`btn ${pending.level === 0 ? 'primary' : 'danger'}`} onClick={() => decide('run')}>
            执行
          </button>
        </>
      }
    >
      <div className="ai-confirm">
        <div className="ai-conf-head">
          <span className={LEVEL_CLS[pending.level]}>L{pending.level} · {riskLabel(pending.level)}</span>
          {pending.level >= 2 && <span className="ai-conf-warn">此操作可能不可逆，请仔细确认</span>}
        </div>
        {pending.features.length > 0 && (
          <ul className="ai-conf-feats">
            {pending.features.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        )}
        <pre className="ai-conf-sql">{pending.sql}</pre>
        {pending.level === 0 && pending.allowRemember && (
          <label className="ai-conf-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住此语句（本会话内相同语句不再确认）
          </label>
        )}
      </div>
    </Modal>
  )
}
