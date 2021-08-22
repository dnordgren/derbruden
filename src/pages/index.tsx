import React from 'react'
import Layout from '@/components/Layout'
import Seo from '@/components/Seo'
import DiaperImg2020 from '@/components/DiaperImg2020'
import DiaperImg2019 from '@/components/DiaperImg2019'
import DiaperImg2018 from '@/components/DiaperImg2018'
import DiaperImg2017 from '@/components/DiaperImg2017'
import DiaperImg2016 from '@/components/DiaperImg2016'
import DbTshirt from '@/components/DbTshirt'

const IndexPage = () => {
  return (
    <Layout>
      <Seo title="Der Bruden Home" />
      <h1>Buy Your T-Shirt Now</h1>
      <DbTshirt />
      <p>The greatest accessory since Fight Milk</p>
      <h1>Don&apos;t Come in Last</h1>
      <h2>2020</h2>
      <p>All hail the champion, Midnight in Montgomery</p>
      <DiaperImg2020 />
      <h2>2019</h2>
      <DiaperImg2019 />
      <h2>2018</h2>
      <DiaperImg2018 />
      <h2>2017</h2>
      <DiaperImg2017 />
      <h2>2016</h2>
      <DiaperImg2016 />
    </Layout>
  )
}

export default IndexPage
