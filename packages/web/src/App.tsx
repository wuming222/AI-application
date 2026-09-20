import { useEffect } from 'react'
import { theme, Spin } from 'antd'
import { Workbench } from './components/Workbench'
import { AuthGate } from './components/AuthGate'
import { useAuthStore } from './store/authStore'
import { bootstrapAuth } from './api/auth'
import { resetAccountState } from './store/resetAccountState'
import './App.css'

/**
 * antd v6 在这里没有把 token 暴露成全局 --ant-* 变量（实测组件节点上取不到），
 * 所以把**主题派生的颜色**桥成 --app-* 挂在根上，各组件的同名 .css 用 var() 取。
 * 静态尺度（间距/圆角/字号/阴影/动效）在 styles/tokens.css，别往这里搬，否则同一值两套来源。
 */
function useThemeVars(): React.CSSProperties {
  const { token } = theme.useToken()
  return {
    '--app-text': token.colorText,
    '--app-text-secondary': token.colorTextSecondary,
    '--app-text-tertiary': token.colorTextTertiary,
    '--app-bg-container': token.colorBgContainer,
    '--app-bg-layout': token.colorBgLayout,
    '--app-border': token.colorBorder,
    '--app-border-secondary': token.colorBorderSecondary,
    '--app-split': token.colorSplit,
    '--app-primary': token.colorPrimary,
    '--app-info': token.colorInfo,
    '--app-info-bg': token.colorInfoBg,
    '--app-success': token.colorSuccess,
    '--app-warning': token.colorWarning,
    '--app-error': token.colorError,
    '--app-fill-secondary': token.colorFillSecondary,
    '--app-fill-tertiary': token.colorFillTertiary,
    '--app-fill-quaternary': token.colorFillQuaternary,
  } as React.CSSProperties
}

export default function App() {
  const themeVars = useThemeVars()
  const status = useAuthStore((s) => s.status)

  useEffect(() => {
    void bootstrapAuth()
  }, [])

  // 换账号时清掉"上一个人的会话数据"。放在这里而不是 authStore.signOut 里：
  // authStore 若直接 import 那三个 store 会形成 authStore → chatStore → api/sessions → authStore 的环。
  useEffect(() => {
    if (status === 'signedOut') resetAccountState()
  }, [status])

  return (
    <div className="app-shell" style={themeVars}>
      {status === 'signedIn' ? (
        <Workbench />
      ) : status === 'loading' ? (
        <div className="app-boot">
          <Spin />
        </div>
      ) : (
        <AuthGate />
      )}
    </div>
  )
}
