'use client';
import { FC } from 'react';
import './Planner.scss';
import Header from '../toolbar/Header';
import Year from './Year';
import LoadingSpinner from '../../../component/LoadingSpinner/LoadingSpinner';
import { useAppSelector } from '../../../store/hooks';
import { selectYearPlans } from '../../../store/slices/roadmapSlice';
import { getTotalUnitsFromTransfers } from '../../../helpers/transferCredits';
import { useTransferredCredits } from '../../../hooks/transferCredits';
import Footer from '../../../shared-components/Footer';
import QuarterInfo from '../QuarterInfo/QuarterInfo';

const Planner: FC = () => {
  const currentPlanData = useAppSelector(selectYearPlans);
  const roadmapLoading = useAppSelector((state) => state.roadmap.roadmapLoading);
  const transferred = useTransferredCredits();

  const calculatePlannerOverviewStats = () => {
    let unitCount = 0;
    let slotCount = 0;
    const slots = currentPlanData.flatMap((year) => year.quarters).flatMap((q) => q.courses);
    slots.forEach((slot) => {
      unitCount += slot.type === 'single' ? slot.course.minUnits : Math.max(slot.a.minUnits, slot.b.minUnits);
      slotCount++;
    });

    // add in transfer courses
    const courseCount = slotCount + transferred.courses.length;
    unitCount += getTotalUnitsFromTransfers(transferred.courses, transferred.ap, transferred.ge, transferred.other);
    return { unitCount, courseCount };
  };

  const { unitCount, courseCount } = calculatePlannerOverviewStats();

  const quarterCounts = currentPlanData.map((years) => years.quarters.length);
  const maxQuarterCount = Math.max(...quarterCounts);

  return (
    <div className="planner">
      <Header courseCount={courseCount} unitCount={unitCount} missingPrerequisites={new Set()} />
      {roadmapLoading ? (
        <LoadingSpinner />
      ) : (
        <section className="years" data-max-quarter-count={maxQuarterCount}>
          {currentPlanData.map((year, yearIndex) => {
            return <Year key={yearIndex} yearIndex={yearIndex} data={year} />;
          })}
        </section>
      )}

      <div className="app-footer">
        <Footer />
        <QuarterInfo />
      </div>
    </div>
  );
};

export default Planner;
