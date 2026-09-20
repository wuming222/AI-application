import { useState } from 'react'
import { Alert, Button, Form, Input, Segmented } from 'antd'
import { login, register } from '../api/auth'
import { useAuthStore } from '../store/authStore'
import './AuthGate.css'

/**
 * 登录卡。这个应用定位成"别人能注册进来用的服务"，所以注册是**进门的唯一路径** ——
 * 没有匿名态，也就没有"这台设备是谁"的问题（见 docs/SDD/multi-tenant-p0/SDD.md）。
 *
 * 忘记密码这条只有人工一条路：服务端没有发信/发短信的带外通道，
 * 站长用 `python -m app.scripts.reset_password` 在本地改，前台这里只负责把人指过去。
 */

type Mode = '登录' | '注册'

interface FormValues {
  username: string
  password: string
}

export function AuthGate() {
  const [mode, setMode] = useState<Mode>('登录')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = useAuthStore((s) => s.signIn)

  const submit = async (values: FormValues) => {
    setPending(true)
    setError(null)
    try {
      const payload = mode === '登录'
        ? await login(values.username, values.password)
        : await register(values.username, values.password)
      signIn(payload.token, payload.user.username)
    } catch (err) {
      // 后端的文案本身就是给人看的（"用户名或密码不对" / "该用户名已被占用"），直接透传
      setError((err as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="auth-gate">
      <div className="auth-gate-card">
        <div className="auth-gate-title">AI 应用生成</div>
        <Segmented
          block
          value={mode}
          onChange={(v) => { setMode(v as Mode); setError(null) }}
          options={['登录', '注册']}
        />
        <Form<FormValues> layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input autoComplete="username" maxLength={32} placeholder="中文 / 字母 / 数字 / _ -" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete={mode === '登录' ? 'current-password' : 'new-password'} maxLength={72} />
          </Form.Item>
          {error ? <Alert className="auth-gate-error" type="error" showIcon message={error} /> : null}
          <Button type="primary" htmlType="submit" block loading={pending}>
            {mode}
          </Button>
        </Form>
        <div className="auth-gate-hint">
          忘记密码？联系站长在服务器上人工重置。
        </div>
      </div>
    </div>
  )
}
