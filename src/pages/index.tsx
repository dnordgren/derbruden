import React from 'react'
import Layout from '@/components/Layout'
import Seo from '@/components/Seo'
import DiaperImg2021 from '@/components/DiaperImg2021'
import DiaperImg2020 from '@/components/DiaperImg2020'
import DiaperImg2019 from '@/components/DiaperImg2019'
import DiaperImg2018 from '@/components/DiaperImg2018'
import DiaperImg2017 from '@/components/DiaperImg2017'
import DiaperImg2016 from '@/components/DiaperImg2016'
import DbTshirt from '@/components/DbTshirt'
import DbStrangeDreamsSticker from '@/components/DbStrangeDreamsSticker'
// @ts-expect-error JavaScript
import { getPageTitle } from '../../config'

const IndexPage = () => {
  return (
    <Layout>
      <Seo title={getPageTitle('Home')} />
      <h1>{"Don't Come in Last"}</h1>
      <p>
        <em>{"Fixing shitty seasons since '16"}</em>
      </p>
      <h2>{'2021 Season'}</h2>
      <DiaperImg2021 />
      <p>{'All hail the champion, King Henry'}</p>
      <p>
        {'Sucker: The Aaron Jones Show. '}
        <em>{'How the mighty have fallen.'}</em>
      </p>
      <h2>{'Having strange dreams lately?'}</h2>
      <DbStrangeDreamsSticker />
      <p>{"You've landed at the source."}</p>
      <h2>{'Buy Your 2021 T-Shirt Now'}</h2>
      <DbTshirt />
      <p>{'The greatest accessory since Fight Milk'}</p>
      <h2>{'2020 Season'}</h2>
      <DiaperImg2020 />
      <p>{'Champion: Midnight in Montgomery'}</p>
      <p>{'Sucker: Diaper King'}</p>
      <h2>{'2019 Season'}</h2>
      <DiaperImg2019 />
      <h2>{'2018 Season'}</h2>
      <DiaperImg2018 />
      <h2>{'2017 Season'}</h2>
      <DiaperImg2017 />
      <h2>{'2016 Season'}</h2>
      <DiaperImg2016 />
    </Layout>
  )
}

export default IndexPage
