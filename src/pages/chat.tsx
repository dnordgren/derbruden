import React from 'react'
import Layout from '@/components/Layout'
import WidgetBot from '@widgetbot/react-embed'

const ChatPage = () => {
  const browserHeight = document.body.offsetHeight
  const browserWidth = document.body.offsetWidth

  const discordWidgetHeight = Math.max(browserHeight - 200 - 100, 500) // 200 = height of header, footer + padding
  const discordWidgetWidth = Math.max(browserWidth - 150, 500) // padding

  return (
    <Layout>
      {// https://docs.widgetbot.io/embed/react-embed/props/
      }
      <WidgetBot
        server="870404843582406696" // Der Bruden
        channel="870404844681322549" // #bruden
        height={discordWidgetHeight}
        width={discordWidgetWidth}
      />
    </Layout>
  )
}

export default ChatPage
