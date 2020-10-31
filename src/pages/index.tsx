import React from 'react'
import Layout from '@/components/Layout'
import Seo from '@/components/Seo'
import StaticImage from '@/components/StaticImage'

const IndexPage = () => {
  return (
    <Layout>
      <Seo title="Der Bruden Home" />
      <h1>Don&apos;t Come in Last</h1>
      <p>2019:</p>
      <StaticImage />
    </Layout>
  )
}

export default IndexPage
