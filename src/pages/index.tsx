import React from 'react'
import Layout from '@/components/Layout'
import Seo from '@/components/Seo'
import DiaperImg2019 from '@/components/DiaperImg2019'
import DiaperImg2018 from '@/components/DiaperImg2018'
import DiaperImg2017 from '@/components/DiaperImg2017'
import DiaperImg2016 from '@/components/DiaperImg2016'

const IndexPage = () => {
  return (
    <Layout>
      <Seo title="Der Bruden Home" />
      <h1>Don&apos;t Come in Last</h1>
      <p>2019:</p>
      <DiaperImg2019 />
      <p>2018:</p>
      <DiaperImg2018 />
      <p>2017:</p>
      <DiaperImg2017 />
      <p>2016:</p>
      <DiaperImg2016 />
    </Layout>
  )
}

export default IndexPage
