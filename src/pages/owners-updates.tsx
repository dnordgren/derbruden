import React from 'react'
import { Link } from 'gatsby'
import Layout from '@/components/Layout'
import Seo from '@/components/Seo'

const OwnersUpdatesPage = () => {
  return (
    <Layout>
      <Seo title="Owners Updates | Der Bruden" />
      <h1>Owners Updates</h1>
      <h2 id="w1">Week 1</h2>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w1-derek-1">Derek: It Begins</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w1-dalton-1">Dalton: Already foaming at the mouth</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w1-andy-1">Andy: The investigation of IBM Watson</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w1-jordan-1">Jordan: Smoldering forests</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w1-cole-1">Cole: Hare Krishna from The Little Engine That Couldn’t</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w1-alec-1">Alec: &quot;To conquer an enemy man must study&quot;</Link>
        </li>
      </ul>
      <h2 id="w3">Week 3</h2>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w3-derek-1">Derek: Rivalry Week</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w3-dalton-1">Dalton: Letters from Lt. Raunch of Denver, CO</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w3-andy-1">Andy: A Modest Proposal (1)</Link>
        </li>
      </ul>
      <h2 id="w4">Week 4</h2>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w4-derek-1">Derek: A Fantasy Haiku</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w4-dalton-1">Dalton: Thee Raunch One</Link>
        </li>
      </ul>
      <h2 id="w13">Week 13</h2>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w13-derek-1">Derek: Dusting off the updates</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w13-alec-1">Alec: A Pleasant Surprise</Link>
        </li>
      </ul>
      <ul>
        <li>
          <Link to="/owners-updates/2020-w13-andy-1">Andy: A Modest Proposal (2)</Link>
        </li>
      </ul>
    </Layout>
  )
}

export default OwnersUpdatesPage
